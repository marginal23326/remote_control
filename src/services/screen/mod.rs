use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use std::thread;
use std::time::Duration;

use bytes::Bytes;
use crossbeam_channel::{Sender, bounded};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_webrtc as gst_webrtc;

use super::owned_worker::OwnedSession;
use super::webrtc_session::{GstCommand, GstSession, WebRtcSignalConfig, spawn_bus_watch, wire_webrtc_signaling};
use crate::realtime::event_names::ServerEvent;

mod frame;
mod pipeline;

use frame::{RawFrame, RecycleBin};
pub(crate) use pipeline::{EncoderPropertyConstraint, detect_encoder, encode_and_webrtc_tail};
use pipeline::{PipelineHandles, apply_encoder_properties};

#[derive(Clone, Debug)]
pub struct StreamSettings {
    pub bitrate: u32,
    pub resolution_percentage: u8,
    pub target_fps: u64,
    pub max_fps: u64,
    pub encoder_properties: HashMap<String, String>,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            bitrate: 5000,
            resolution_percentage: 100,
            target_fps: 60,
            max_fps: backend::get_max_fps(),
            encoder_properties: HashMap::new(),
        }
    }
}

pub struct ScreenManager {
    pub settings: Arc<Mutex<StreamSettings>>,
    pub native_size: Arc<Mutex<(i32, i32)>>,
    pub encoder_type: Arc<Mutex<String>>,
    pub encoder_property_constraints: Arc<Mutex<HashMap<String, EncoderPropertyConstraint>>>,
    session: OwnedSession<InnerState>,
}

struct InnerState {
    pipeline: gst::Pipeline,
    encoder: gst::Element,
    cmd_tx: Sender<GstCommand>,
    input_handle: Option<tokio::task::JoinHandle<()>>,
    pw_handle: Option<thread::JoinHandle<()>>,
    title_handle: Option<thread::JoinHandle<()>>,
    emit_handle: Option<thread::JoinHandle<()>>,
}

impl GstSession for InnerState {
    fn pipeline(&self) -> &gst::Pipeline {
        &self.pipeline
    }

    fn cmd_tx(&self) -> &Sender<GstCommand> {
        &self.cmd_tx
    }

    fn on_stop(self) {
        drop(self.pw_handle);
        drop(self.title_handle);
        drop(self.emit_handle);
        if let Some(handle) = self.input_handle {
            handle.abort();
        }

        #[cfg(target_os = "linux")]
        tokio::spawn(async move {
            linux::portal_session().close().await;
        });
    }
}

impl ScreenManager {
    pub fn new() -> Self {
        let max_fps = backend::get_max_fps();
        let native_size = detect_native_size();
        Self {
            settings: Arc::new(Mutex::new(StreamSettings {
                max_fps,
                ..Default::default()
            })),
            native_size: Arc::new(Mutex::new(native_size)),
            encoder_type: Arc::new(Mutex::new(String::new())),
            encoder_property_constraints: Arc::new(Mutex::new(HashMap::new())),
            session: OwnedSession::new(),
        }
    }

    pub async fn start_stream(
        &self,
        socket: socketioxide::extract::SocketRef,
        state: crate::state::AppState,
        capture_cursor: bool,
    ) -> anyhow::Result<()> {
        let startup_guard = self
            .session
            .ownership()
            .try_start(socket.id.to_string())
            .map_err(|_| anyhow::anyhow!("Stream is already active on another client"))?;

        gst::init().map_err(|e| anyhow::anyhow!("GStreamer init failed: {e}"))?;

        let PipelineHandles {
            pipeline,
            appsrc,
            webrtcbin,
            encoder,
            min_dim,
        } = self.build_pipeline()?;

        let (cmd_tx, cmd_rx) = bounded::<GstCommand>(32);

        let (frame_tx, frame_rx): (Sender<RawFrame>, _) = bounded(3);
        let (recycle_tx, recycle_rx): (Sender<Vec<u8>>, _) = bounded(5);

        wire_webrtc_signaling(
            &webrtcbin,
            cmd_rx,
            socket.clone(),
            state.config.stun_server.clone(),
            WebRtcSignalConfig {
                label: "screen",
                offer_event: ServerEvent::WebrtcOffer.as_str(),
                ice_event: ServerEvent::WebrtcRemoteIce.as_str(),
            },
        );
        let input_handle =
            Self::setup_input_data_channels(&webrtcbin, state.input.clone(), tokio::runtime::Handle::current());

        let is_running = self.session.ownership().running_flag();
        let settings = self.settings.clone();

        spawn_bus_watch(pipeline.clone(), "screen", || {});

        #[cfg(target_os = "linux")]
        let (pw_handle, title_handle): (Option<thread::JoinHandle<()>>, Option<thread::JoinHandle<()>>) = {
            let (pw_node_id, pw_size, pw_fd) = {
                let portal = linux::portal_session();
                portal.open_pipewire_remote(capture_cursor).await
            }?;
            *self.native_size.lock() = pw_size;

            let is_running_cap = is_running.clone();
            let settings_cap = settings.clone();
            let frame_tx_cap = frame_tx.clone();
            let recycle_rx_cap = recycle_rx.clone();
            let native_size_cap = self.native_size.clone();

            let pw = thread::spawn(move || {
                if let Err(e) = linux::run_pipewire_capture(
                    pw_node_id,
                    pw_fd,
                    frame_tx_cap,
                    recycle_rx_cap,
                    settings_cap,
                    is_running_cap,
                    native_size_cap,
                ) {
                    tracing::error!("PipeWire capture error: {e:#}");
                }
            });

            let title = {
                let r = is_running.clone();
                thread::spawn(move || linux::run_active_window_title_poll(r))
            };

            (Some(pw), Some(title))
        };

        #[cfg(windows)]
        let (pw_handle, title_handle): (Option<thread::JoinHandle<()>>, Option<thread::JoinHandle<()>>) = {
            windows::start_os_capture(
                frame_tx,
                recycle_rx,
                settings.clone(),
                is_running.clone(),
                self.native_size.clone(),
                capture_cursor,
            )
            .await?;

            (None, None)
        };

        let mut inner = InnerState {
            pipeline,
            encoder,
            cmd_tx,
            input_handle: Some(input_handle),
            pw_handle,
            title_handle,
            emit_handle: None,
        };

        let emit_handle = {
            let socket_emit = socket.clone();
            let is_running_emit = is_running.clone();
            thread::spawn(move || {
                let mut last = String::new();
                while is_running_emit.load(Ordering::SeqCst) {
                    let title = backend::get_active_window_title();
                    if title != last {
                        last = title;
                        let _ =
                            socket_emit.emit(ServerEvent::ActiveWindow.as_str(), &serde_json::json!({"title": &last}));
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            })
        };

        let is_running_enc = is_running.clone();
        let settings_enc = settings.clone();
        let frame_rx_enc = frame_rx;

        let (scaler_recycle_tx, scaler_recycle_rx): (Sender<Vec<u8>>, _) = bounded(3);
        let capture_recycle_tx = recycle_tx.clone();

        thread::spawn(move || {
            use fast_image_resize::{
                PixelType, ResizeAlg, ResizeOptions, Resizer,
                images::{Image, ImageRef},
            };

            let mut resizer = Resizer::new();
            let mut last_width = 0;
            let mut last_height = 0;

            while is_running_enc.load(Ordering::SeqCst) {
                let Ok(mut raw) = frame_rx_enc.recv_timeout(Duration::from_millis(100)) else {
                    continue;
                };

                if !is_running_enc.load(Ordering::SeqCst) {
                    break;
                }

                let scale_pct = settings_enc.lock().resolution_percentage;

                let new_w = ((raw.width * scale_pct as u32 / 100).max(min_dim) / 2) * 2;
                let new_h = ((raw.height * scale_pct as u32 / 100).max(min_dim) / 2) * 2;

                let (push_buf, push_tx) = if new_w != raw.width || new_h != raw.height {
                    let required = (new_w * new_h * 4) as usize;

                    let mut final_buf = scaler_recycle_rx.try_recv().unwrap_or_else(|_| vec![0u8; required]);
                    if final_buf.len() != required {
                        final_buf.resize(required, 0);
                    }

                    let src = ImageRef::new(raw.width, raw.height, &raw.buffer, PixelType::U8x4).unwrap();
                    let mut dst = Image::from_slice_u8(new_w, new_h, &mut final_buf, PixelType::U8x4).unwrap();
                    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Nearest);

                    if resizer.resize(&src, &mut dst, &opts).is_ok() {
                        let _ = capture_recycle_tx.try_send(raw.buffer);

                        raw.width = new_w;
                        raw.height = new_h;
                        (final_buf, scaler_recycle_tx.clone())
                    } else {
                        (raw.buffer, capture_recycle_tx.clone())
                    }
                } else {
                    (raw.buffer, capture_recycle_tx.clone())
                };

                if raw.width != last_width || raw.height != last_height {
                    let caps = gst::Caps::builder("video/x-raw")
                        .field("format", "BGRA")
                        .field("width", raw.width as i32)
                        .field("height", raw.height as i32)
                        .build();
                    appsrc.set_caps(Some(&caps));
                    last_width = raw.width;
                    last_height = raw.height;
                }

                let recycled = RecycleBin {
                    buffer: Some(push_buf),
                    tx: push_tx,
                };

                let buffer = gst::Buffer::from_mut_slice(recycled);
                if appsrc.push_buffer(buffer).is_err() {
                    tracing::debug!("Appsrc: push_buffer failed (shutting down?)");
                    break;
                }
            }
        });

        inner.emit_handle = Some(emit_handle);
        self.session.finish_or_abort(
            startup_guard,
            inner,
            |inner| {
                let _ = inner.pipeline.set_state(gst::State::Null);
            },
            || anyhow::anyhow!("Client disconnected during stream startup"),
        )
    }

    fn setup_input_data_channels(
        webrtcbin: &gst::Element,
        input: crate::services::input::InputManager,
        runtime: tokio::runtime::Handle,
    ) -> tokio::task::JoinHandle<()> {
        let (move_tx, mut move_rx) = tokio::sync::watch::channel::<Option<crate::services::input::MouseEvent>>(None);
        let (control_tx, mut control_rx) = tokio::sync::mpsc::unbounded_channel::<crate::services::input::MouseEvent>();

        let input_handle = runtime.spawn(async move {
            let mut move_open = true;
            let mut control_open = true;
            let mut last_low_latency_seq = 0u64;

            loop {
                if !move_open && !control_open {
                    break;
                }

                tokio::select! {
                    biased;

                    event = control_rx.recv(), if control_open => {
                        if let Some(event) = event {
                            crate::services::input::apply_mouse_event(&input, event).await;
                        } else {
                            control_open = false;
                        }
                    }

                    changed = move_rx.changed(), if move_open => {
                        if changed.is_err() {
                            move_open = false;
                            continue;
                        }
                        let event = move_rx.borrow_and_update().clone();
                            if let Some(event) = event {
                                if let Some(seq) = event.seq {
                                    if seq <= last_low_latency_seq {
                                        continue;
                                    }
                                    last_low_latency_seq = seq;
                                }
                                crate::services::input::apply_mouse_event(&input, event).await;
                            }
                    }
                }
            }
        });

        let move_options = gst::Structure::builder("options")
            .field("ordered", false)
            .field("max-retransmits", 0i32)
            .build();

        let move_channel = webrtcbin
            .emit_by_name::<Option<gst_webrtc::WebRTCDataChannel>>(
                "create-data-channel",
                &[&"mouse-move", &move_options],
            )
            .expect("Failed to create mouse-move data channel");
        Self::attach_mouse_data_channel(
            &move_channel,
            |t| t == "move",
            move |e| {
                let _ = move_tx.send(Some(e));
            },
        );

        let control_channel = webrtcbin
            .emit_by_name::<Option<gst_webrtc::WebRTCDataChannel>>(
                "create-data-channel",
                &[&"mouse-control", &None::<gst::Structure>],
            )
            .expect("Failed to create mouse-control data channel");
        Self::attach_mouse_data_channel(
            &control_channel,
            |t| t != "move",
            move |e| {
                let _ = control_tx.send(e);
            },
        );

        input_handle
    }

    fn attach_mouse_data_channel(
        channel: &gst_webrtc::WebRTCDataChannel,
        accept: impl Fn(&str) -> bool + Send + Sync + 'static,
        forward: impl Fn(crate::services::input::MouseEvent) + Send + Sync + 'static,
    ) {
        channel.connect_on_message_string(move |_, message| {
            let Some(message) = message else {
                return;
            };

            let Ok(event) = serde_json::from_str::<crate::services::input::MouseEvent>(message) else {
                tracing::debug!("Ignoring malformed mouse data-channel message");
                return;
            };

            if accept(&event.r#type) {
                forward(event);
            }
        });
    }

    pub fn stop_stream(&self) {
        self.session.stop();
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) -> bool {
        self.session.stop_if_owner(owner_id)
    }

    pub fn set_remote_description(&self, sdp: String) {
        self.session.set_remote_description(sdp);
    }

    pub fn add_ice_candidate(&self, sdp_mline_index: u32, candidate: String) {
        self.session.add_ice_candidate(sdp_mline_index, candidate);
    }

    pub fn update_settings(&self, bitrate: u32, resolution: u8) {
        let bitrate = bitrate.clamp(100, 20000);
        let resolution = resolution.clamp(5, 100);

        {
            let mut s = self.settings.lock();
            s.bitrate = bitrate;
            s.resolution_percentage = resolution;
        }

        self.session.with_inner(|state| {
            state.encoder.set_property_from_str("bitrate", &bitrate.to_string());
        });
    }

    pub fn set_target_fps(&self, fps: u64) {
        let mut s = self.settings.lock();
        s.target_fps = fps.clamp(1, s.max_fps);
    }

    pub fn set_encoder_properties(&self, properties: HashMap<String, String>) -> Vec<String> {
        let rejected = self
            .session
            .with_inner(|state| apply_encoder_properties(&state.encoder, &properties))
            .unwrap_or_default();
        {
            let mut s = self.settings.lock();
            s.encoder_properties = properties;
            for key in &rejected {
                s.encoder_properties.remove(key);
            }
        }
        rejected
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "linux")]
use linux as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

pub async fn take_screenshot() -> anyhow::Result<(Bytes, &'static str)> {
    backend::take_screenshot().await
}

fn detect_native_size() -> (i32, i32) {
    #[cfg(windows)]
    {
        windows::get_display_native_size()
    }
    #[cfg(not(windows))]
    {
        (0, 0)
    }
}
