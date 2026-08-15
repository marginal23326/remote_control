use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

use bytes::Bytes;
use crossbeam_channel::{Receiver, Sender, bounded};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_webrtc as gst_webrtc;

use super::owned_worker::OwnedSession;
use super::webrtc_session::{
    GstCommand, GstSession, IceServerConfig, WebRtcManager, WebRtcSignalConfig, spawn_bus_watch, stop_owner_on_exit,
    wire_webrtc_signaling,
};
use crate::realtime::event_names::ServerEvent;
use crate::realtime::payloads::ActiveWindowPayload;
use crate::services::input::MouseEventPayload;

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

#[derive(Clone, Debug, Default)]
pub struct ScreenState {
    pub settings: StreamSettings,
    pub native_size: (i32, i32),
    pub encoder_type: String,
    pub encoder_property_constraints: HashMap<String, EncoderPropertyConstraint>,
}

pub struct ScreenManager {
    state: Arc<Mutex<ScreenState>>,
    session: OwnedSession<InnerState>,
}

pub(crate) struct InnerState {
    pipeline: gst::Pipeline,
    encoder: gst::Element,
    cmd_tx: Sender<GstCommand>,
    input_handle: tokio::task::JoinHandle<()>,
}

impl GstSession for InnerState {
    fn pipeline(&self) -> &gst::Pipeline {
        &self.pipeline
    }

    fn cmd_tx(&self) -> &Sender<GstCommand> {
        &self.cmd_tx
    }

    fn on_stop(self) {
        self.input_handle.abort();

        #[cfg(target_os = "linux")]
        tokio::spawn(async move {
            linux::portal_session().close().await;
        });
    }
}

impl ScreenManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ScreenState {
                native_size: detect_native_size(),
                ..Default::default()
            })),
            session: OwnedSession::new(),
        }
    }

    pub fn snapshot(&self) -> ScreenState {
        self.state.lock().clone()
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
            IceServerConfig {
                stun: state.config.stun_server.clone(),
                turn: state.config.turn_server.clone(),
            },
            WebRtcSignalConfig {
                label: "screen",
                offer_event: ServerEvent::WebrtcOffer.as_str(),
                ice_event: ServerEvent::WebrtcRemoteIce.as_str(),
            },
        );
        let input_handle =
            Self::setup_input_data_channels(&webrtcbin, state.input.clone(), tokio::runtime::Handle::current());

        let is_running = self.session.ownership().running_flag();
        let screen_state = self.state.clone();

        spawn_bus_watch(
            pipeline.clone(),
            "screen",
            stop_owner_on_exit(state.screen.clone(), socket.id.to_string()),
        );

        backend::start_capture(
            frame_tx,
            recycle_rx,
            screen_state.clone(),
            is_running.clone(),
            capture_cursor,
            stop_owner_on_exit(state.screen.clone(), socket.id.to_string()),
        )
        .await?;

        {
            let socket_emit = socket.clone();
            let is_running_emit = is_running.clone();
            thread::spawn(move || {
                let mut last = String::new();
                while is_running_emit.load(Ordering::Relaxed) {
                    let title = backend::get_active_window_title();
                    if title != last {
                        last = title;
                        let _ = socket_emit.emit(
                            ServerEvent::ActiveWindow.as_str(),
                            &ActiveWindowPayload { title: last.clone() },
                        );
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            });
        }

        Self::spawn_resize_encode_thread(is_running, screen_state, frame_rx, appsrc, min_dim, recycle_tx);

        let inner = InnerState {
            pipeline,
            encoder,
            cmd_tx,
            input_handle,
        };

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
        let (move_tx, mut move_rx) = tokio::sync::watch::channel::<Option<MouseEventPayload>>(None);
        let (control_tx, mut control_rx) = tokio::sync::mpsc::unbounded_channel::<MouseEventPayload>();

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
                                if let MouseEventPayload::Move { seq: Some(seq), .. } = &event {
                                    if *seq <= last_low_latency_seq {
                                        continue;
                                    }
                                    last_low_latency_seq = *seq;
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
            |e| matches!(e, MouseEventPayload::Move { .. }),
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
            |e| !matches!(e, MouseEventPayload::Move { .. }),
            move |e| {
                let _ = control_tx.send(e);
            },
        );

        input_handle
    }

    fn spawn_resize_encode_thread(
        is_running: Arc<AtomicBool>,
        state: Arc<Mutex<ScreenState>>,
        frame_rx: Receiver<RawFrame>,
        appsrc: gstreamer_app::AppSrc,
        min_dim: u32,
        recycle_tx: Sender<Vec<u8>>,
    ) {
        let (scaler_recycle_tx, scaler_recycle_rx): (Sender<Vec<u8>>, _) = bounded(3);

        thread::spawn(move || {
            use fast_image_resize::{
                PixelType, ResizeAlg, ResizeOptions, Resizer,
                images::{Image, ImageRef},
            };

            let mut resizer = Resizer::new();
            let mut last_width = 0;
            let mut last_height = 0;

            while is_running.load(Ordering::Relaxed) {
                let Ok(mut raw) = frame_rx.recv_timeout(Duration::from_millis(100)) else {
                    continue;
                };

                if !is_running.load(Ordering::Relaxed) {
                    break;
                }

                let scale_pct = state.lock().settings.resolution_percentage;

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
                        let _ = recycle_tx.try_send(raw.buffer);

                        raw.width = new_w;
                        raw.height = new_h;
                        (final_buf, scaler_recycle_tx.clone())
                    } else {
                        (raw.buffer, recycle_tx.clone())
                    }
                } else {
                    (raw.buffer, recycle_tx.clone())
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
    }

    fn attach_mouse_data_channel(
        channel: &gst_webrtc::WebRTCDataChannel,
        accept: impl Fn(&MouseEventPayload) -> bool + Send + Sync + 'static,
        forward: impl Fn(MouseEventPayload) + Send + Sync + 'static,
    ) {
        channel.connect_on_message_string(move |_, message| {
            let Some(message) = message else {
                return;
            };

            let Ok(event) = serde_json::from_str::<MouseEventPayload>(message) else {
                tracing::debug!("Ignoring malformed mouse data-channel message");
                return;
            };

            if accept(&event) {
                forward(event);
            }
        });
    }

    pub fn update_settings(&self, bitrate: u32, resolution: u8) {
        let bitrate = bitrate.clamp(100, 20000);
        let resolution = resolution.clamp(5, 100);

        {
            let mut state = self.state.lock();
            state.settings.bitrate = bitrate;
            state.settings.resolution_percentage = resolution;
        }

        self.session.with_inner(|inner| {
            inner.encoder.set_property_from_str("bitrate", &bitrate.to_string());
        });
    }

    pub fn set_target_fps(&self, fps: u64) {
        let mut state = self.state.lock();
        let max_fps = state.settings.max_fps;
        state.settings.target_fps = fps.clamp(1, max_fps);
    }

    pub fn set_encoder_properties(&self, properties: HashMap<String, String>) -> Vec<String> {
        let rejected = self
            .session
            .with_inner(|inner| apply_encoder_properties(&inner.encoder, &properties))
            .unwrap_or_default();
        {
            let mut state = self.state.lock();
            state.settings.encoder_properties = properties;
            for key in &rejected {
                state.settings.encoder_properties.remove(key);
            }
        }
        rejected
    }
}

impl WebRtcManager for ScreenManager {
    type Session = InnerState;

    fn session(&self) -> &OwnedSession<InnerState> {
        &self.session
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
