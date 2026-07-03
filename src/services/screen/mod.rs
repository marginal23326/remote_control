use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crossbeam_channel::{Sender, bounded};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer::glib;
use gstreamer_app as gst_app;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;

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
            max_fps: detect_max_fps(),
            encoder_properties: HashMap::new(),
        }
    }
}

pub(crate) struct RawFrame {
    pub buffer: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

struct RecycleBin {
    buffer: Option<Vec<u8>>,
    tx: crossbeam_channel::Sender<Vec<u8>>,
}

impl AsRef<[u8]> for RecycleBin {
    fn as_ref(&self) -> &[u8] {
        self.buffer.as_ref().unwrap()
    }
}

impl AsMut<[u8]> for RecycleBin {
    fn as_mut(&mut self) -> &mut [u8] {
        self.buffer.as_mut().unwrap()
    }
}

impl Drop for RecycleBin {
    fn drop(&mut self) {
        if let Some(buf) = self.buffer.take() {
            let _ = self.tx.try_send(buf);
        }
    }
}

pub(crate) struct FrameRateLimiter {
    last_arrival: Instant,
    accumulated: Duration,
}

impl FrameRateLimiter {
    pub(crate) fn new() -> Self {
        Self {
            last_arrival: Instant::now(),
            accumulated: Duration::ZERO,
        }
    }

    pub(crate) fn should_process(&mut self, target_fps: u64, max_fps: u64) -> bool {
        if target_fps >= max_fps {
            return true;
        }

        let now = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / target_fps as f64);
        let elapsed = now.saturating_duration_since(self.last_arrival);

        self.last_arrival = now;
        self.accumulated += elapsed;

        if self.accumulated >= interval {
            self.accumulated -= interval;

            if self.accumulated >= interval {
                self.accumulated = Duration::ZERO;
            }

            true
        } else {
            false
        }
    }
}

pub(crate) enum GstCommand {
    SetRemoteDescription(String),
    AddIceCandidate { sdp_mline_index: u32, candidate: String },
    Stop,
}

#[derive(Serialize, Clone, Debug)]
pub struct EncoderPropertyConstraint {
    pub value_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<&'static [&'static str]>,
}

struct EncoderInfo {
    name: &'static str,
    pipeline_str: &'static str,
    default_properties: &'static [(&'static str, &'static str)],
    property_constraints: &'static [(&'static str, EncoderPropertyConstraint)],
    min_dim: u32,
}

fn detect_encoder() -> EncoderInfo {
    #[cfg(windows)]
    {
        if gst::Registry::get()
            .find_feature("mfh264enc", gst::PluginFeature::static_type())
            .is_some()
        {
            return EncoderInfo {
                name: "mfh264enc",
                pipeline_str: "mfh264enc name=enc low-latency=true rc-mode=0 gop-size=30 ref=1",
                default_properties: &[
                    ("low-latency", "true"),
                    ("rc-mode", "0"),
                    ("gop-size", "30"),
                    ("ref", "1"),
                ],
                #[rustfmt::skip]
                property_constraints: &[
                    ("low-latency", EncoderPropertyConstraint { value_type: "bool", min: None, max: None, enum_values: None }),
                    ("rc-mode", EncoderPropertyConstraint { value_type: "int", min: Some(0), max: Some(3), enum_values: None }),
                    ("gop-size", EncoderPropertyConstraint { value_type: "int", min: Some(0), max: Some(1000), enum_values: None }),
                    ("ref", EncoderPropertyConstraint { value_type: "int", min: Some(0), max: Some(16), enum_values: None }),
                ],
                min_dim: 64,
            };
        }
    }

    #[cfg(target_os = "linux")]
    {
        if gst::Registry::get()
            .find_feature("vah264enc", gst::PluginFeature::static_type())
            .is_some()
        {
            return EncoderInfo {
                name: "vah264enc",
                pipeline_str: "vah264enc name=enc target-usage=7 rate-control=cbr key-int-max=30 ref-frames=1 cpb-size=100",
                default_properties: &[
                    ("target-usage", "7"),
                    ("rate-control", "cbr"),
                    ("key-int-max", "30"),
                    ("ref-frames", "1"),
                    ("cpb-size", "100"),
                ],
                #[rustfmt::skip]
                property_constraints: &[
                    ("target-usage", EncoderPropertyConstraint { value_type: "int", min: Some(1), max: Some(7), enum_values: None }),
                    ("rate-control", EncoderPropertyConstraint { value_type: "enum", min: None, max: None, enum_values: Some(&["cbr", "vbr", "cqp"]) }),
                    ("key-int-max", EncoderPropertyConstraint { value_type: "int", min: Some(0), max: Some(1024), enum_values: None }),
                    ("ref-frames", EncoderPropertyConstraint { value_type: "int", min: Some(0), max: Some(16), enum_values: None }),
                    ("cpb-size", EncoderPropertyConstraint { value_type: "int", min: Some(0), max: Some(2048000), enum_values: None }),
                ],
                min_dim: 128,
            };
        }
    }

    tracing::warn!("No hardware encoder found. Falling back to CPU (x264enc)");
    EncoderInfo {
        name: "x264enc",
        pipeline_str: "x264enc name=enc tune=zerolatency speed-preset=ultrafast",
        default_properties: &[("tune", "zerolatency"), ("speed-preset", "ultrafast")],
        #[rustfmt::skip]
        property_constraints: &[
            ("tune", EncoderPropertyConstraint { value_type: "enum", min: None, max: None, enum_values: Some(&["stillimage", "fastdecode", "zerolatency"]) }),
            ("speed-preset", EncoderPropertyConstraint { value_type: "enum", min: None, max: None, enum_values: Some(&["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"]) }),
        ],
        min_dim: 2,
    }
}

pub struct ScreenManager {
    pub settings: Arc<Mutex<StreamSettings>>,
    pub native_size: Arc<Mutex<(i32, i32)>>,
    pub encoder_type: Arc<Mutex<String>>,
    pub encoder_property_constraints: Arc<Mutex<HashMap<String, EncoderPropertyConstraint>>>,
    pub(crate) inner: Mutex<Option<InnerState>>,
    is_running: Arc<AtomicBool>,
    owner_id: Mutex<Option<String>>,
}

pub(crate) struct InnerState {
    pub(crate) pipeline: gst::Pipeline,
    pub(crate) encoder: gst::Element,
    pub(crate) cmd_tx: crossbeam_channel::Sender<GstCommand>,
    input_handle: Option<tokio::task::JoinHandle<()>>,
    pw_handle: Option<thread::JoinHandle<()>>,
    title_handle: Option<thread::JoinHandle<()>>,
    emit_handle: Option<thread::JoinHandle<()>>,
}

struct StreamGuard {
    is_running: Arc<AtomicBool>,
    success: bool,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if !self.success {
            tracing::warn!("Stream startup failed or was interrupted. Resetting is_running flag.");
            self.is_running.store(false, Ordering::SeqCst);
        }
    }
}

impl ScreenManager {
    pub fn new() -> Self {
        let max_fps = detect_max_fps();
        let native_size = detect_native_size();
        Self {
            settings: Arc::new(Mutex::new(StreamSettings {
                max_fps,
                ..Default::default()
            })),
            native_size: Arc::new(Mutex::new(native_size)),
            encoder_type: Arc::new(Mutex::new(String::new())),
            encoder_property_constraints: Arc::new(Mutex::new(HashMap::new())),
            is_running: Arc::new(AtomicBool::new(false)),
            inner: Mutex::new(None),
            owner_id: Mutex::new(None),
        }
    }

    pub async fn start_stream(
        &self,
        socket: socketioxide::extract::SocketRef,
        state: crate::state::SharedState,
    ) -> anyhow::Result<()> {
        if self
            .is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(anyhow::anyhow!("Stream is already active on another client"));
        }

        *self.owner_id.lock() = Some(socket.id.to_string());

        let mut startup_guard = StreamGuard {
            is_running: self.is_running.clone(),
            success: false,
        };

        gst::init().map_err(|e| anyhow::anyhow!("GStreamer init failed: {e}"))?;

        let encoder_info = detect_encoder();
        let encoder_str = encoder_info.pipeline_str;
        let min_dim = encoder_info.min_dim;
        *self.encoder_type.lock() = encoder_info.name.to_string();
        *self.encoder_property_constraints.lock() = encoder_info
            .property_constraints
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();

        {
            let mut s = self.settings.lock();
            if s.encoder_properties.is_empty() {
                s.encoder_properties = encoder_info
                    .default_properties
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
            }
        }

        let pipeline_str = format!(
            "appsrc name=src \
                is-live=true \
                block=false \
                format=time \
                do-timestamp=true \
                max-buffers=2 \
                leaky-type=downstream \
                max-bytes=0 ! \
             queue \
                leaky=downstream \
                max-size-buffers=2 \
                max-size-time=0 \
                max-size-bytes=0 ! \
             videoconvert ! \
             video/x-raw,format=NV12 ! \
             queue \
                leaky=downstream \
                max-size-buffers=2 \
                max-size-time=0 \
                max-size-bytes=0 ! \
             {} ! \
             rtph264pay config-interval=-1 aggregate-mode=zero-latency ! \
             webrtcbin name=webrtc \
                bundle-policy=max-bundle \
                latency=0",
            encoder_str
        );

        let pipeline = gst::parse::launch(&pipeline_str)
            .map_err(|e| anyhow::anyhow!("Failed to create pipeline: {e}"))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| anyhow::anyhow!("Failed to downcast to Pipeline"))?;

        let appsrc = pipeline
            .by_name("src")
            .ok_or_else(|| anyhow::anyhow!("appsrc not found"))?
            .dynamic_cast::<gst_app::AppSrc>()
            .map_err(|_| anyhow::anyhow!("Failed to cast to AppSrc"))?;

        let webrtcbin = pipeline
            .by_name("webrtc")
            .ok_or_else(|| anyhow::anyhow!("webrtcbin not found"))?;

        let encoder = pipeline
            .by_name("enc")
            .ok_or_else(|| anyhow::anyhow!("Encoder not found"))?;

        let default_bitrate = self.settings.lock().bitrate;
        encoder.set_property_from_str("bitrate", &default_bitrate.to_string());

        let encoder_properties = self.settings.lock().encoder_properties.clone();
        apply_encoder_properties(&encoder, &encoder_properties);

        pipeline
            .set_state(gst::State::Ready)
            .map_err(|e| anyhow::anyhow!("Failed to set pipeline to Ready: {e}"))?;

        let (cmd_tx, cmd_rx) = bounded::<GstCommand>(32);

        let (frame_tx, frame_rx): (Sender<RawFrame>, _) = bounded(3);
        let (recycle_tx, recycle_rx): (Sender<Vec<u8>>, _) = bounded(5);

        let socket_signal = socket.clone();
        let input_handle = Self::setup_webrtc_signals(
            &webrtcbin,
            &cmd_rx,
            socket_signal,
            state.input.clone(),
            tokio::runtime::Handle::current(),
            state.config.stun_server.clone(),
        );

        let is_running = self.is_running.clone();
        let settings = self.settings.clone();

        let pipeline_clone = pipeline.clone();
        let pipeline_weak = pipeline_clone.downgrade();

        thread::spawn(move || {
            let res = pipeline_clone.set_state(gst::State::Playing);
            tracing::debug!("Pipeline state set to Playing: {res:?}");
            for msg in pipeline_clone.bus().unwrap().iter_timed(None::<gst::ClockTime>) {
                use gst::MessageView;
                match msg.view() {
                    MessageView::Eos(..) => {
                        tracing::info!("Pipeline bus: EOS");
                        break;
                    }
                    MessageView::Error(err) => {
                        tracing::error!("Pipeline bus error: {}", err.error());
                        if let Some(dbg) = err.debug() {
                            tracing::error!("  Debug: {dbg}");
                        }
                        break;
                    }
                    MessageView::Warning(warn) => {
                        tracing::warn!("Pipeline bus warning: {}", warn.error());
                        if let Some(dbg) = warn.debug() {
                            tracing::warn!("  Warn debug: {dbg}");
                        }
                    }
                    _ => {}
                }
            }
            let _ = pipeline_weak.upgrade().map(|p| p.set_state(gst::State::Null));
        });

        #[cfg(target_os = "linux")]
        let mut inner = {
            let (pw_node_id, pw_size, pw_fd) = {
                let portal = linux::portal_session();
                portal.open_pipewire_remote().await
            }?;
            *self.native_size.lock() = pw_size;

            let is_running_cap = is_running.clone();
            let settings_cap = settings.clone();
            let frame_tx_cap = frame_tx.clone();
            let recycle_rx_cap = recycle_rx.clone();
            let native_size_cap = self.native_size.clone();

            let pw_handle = thread::spawn(move || {
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

            let title_handle = {
                let r = is_running.clone();
                thread::spawn(move || linux::run_active_window_title_poll(r))
            };

            InnerState {
                pipeline,
                encoder,
                cmd_tx,
                input_handle: Some(input_handle),
                pw_handle: Some(pw_handle),
                title_handle: Some(title_handle),
                emit_handle: None,
            }
        };

        #[cfg(windows)]
        let mut inner = {
            windows::start_os_capture(
                frame_tx,
                recycle_rx,
                settings.clone(),
                is_running.clone(),
                self.native_size.clone(),
            )
            .await?;

            InnerState {
                pipeline,
                encoder,
                cmd_tx,
                input_handle: Some(input_handle),
                pw_handle: None,
                title_handle: None,
                emit_handle: None,
            }
        };

        let emit_handle = {
            let socket_emit = socket.clone();
            let is_running_emit = is_running.clone();
            thread::spawn(move || {
                let mut last = String::new();
                while is_running_emit.load(Ordering::SeqCst) {
                    let title = get_active_window_title();
                    if title != last {
                        last = title;
                        let _ = socket_emit.emit("active_window", &serde_json::json!({"title": &last}));
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

        if !self.is_running.load(Ordering::SeqCst) {
            let _ = inner.pipeline.set_state(gst::State::Null);
            return Err(anyhow::anyhow!("Client disconnected during stream startup"));
        }

        inner.emit_handle = Some(emit_handle);
        *self.inner.lock() = Some(inner);

        startup_guard.success = true;

        Ok(())
    }

    fn setup_webrtc_signals(
        webrtcbin: &gst::Element,
        cmd_rx: &crossbeam_channel::Receiver<GstCommand>,
        socket: socketioxide::extract::SocketRef,
        input: crate::services::input::InputManager,
        runtime: tokio::runtime::Handle,
        stun_server: Option<String>,
    ) -> tokio::task::JoinHandle<()> {
        let wtc = webrtcbin.clone();

        if let Some(stun) = stun_server
            && !stun.is_empty()
        {
            webrtcbin.set_property_from_str("stun-server", &stun);
        }

        {
            let socket_nego = socket.clone();
            wtc.connect("on-negotiation-needed", false, move |args| {
                let webrtc: gst::Element = args[0].get().unwrap();
                let socket = socket_nego.clone();
                let webrtc_promise = webrtc.clone();

                let promise = gst::Promise::with_change_func(move |reply| {
                    if let Ok(Some(structure)) = reply
                        && let Ok(offer) = structure.get::<gst_webrtc::WebRTCSessionDescription>("offer")
                        && let Ok(sdp_text) = offer.sdp().as_text()
                    {
                        webrtc_promise.emit_by_name::<()>("set-local-description", &[&offer, &None::<gst::Promise>]);
                        let _ = socket.emit("webrtc_offer", &sdp_text);
                    }
                });

                webrtc.emit_by_name::<()>("create-offer", &[&None::<gst::Structure>, &promise]);

                None
            });
        }

        {
            let socket_ice = socket.clone();
            wtc.connect("on-ice-candidate", false, move |args| {
                let sdp_mline_index: u32 = args[1].get().unwrap();
                let candidate: String = args[2].get().unwrap();
                let data = serde_json::json!({
                    "sdp_mline_index": sdp_mline_index,
                    "candidate": candidate,
                });
                let _ = socket_ice.emit("webrtc_remote_ice", &data);
                None
            });
        }

        let input_handle = Self::setup_input_data_channels(webrtcbin, input, runtime);

        let cmd_rx_clone = cmd_rx.clone();
        let webrtc = wtc.clone();
        thread::spawn(move || {
            while let Ok(cmd) = cmd_rx_clone.recv() {
                match cmd {
                    GstCommand::SetRemoteDescription(sdp_text) => {
                        if let Ok(sdp) = gst_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes()) {
                            let desc =
                                gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Answer, sdp);
                            webrtc.emit_by_name::<()>("set-remote-description", &[&desc, &None::<gst::Promise>]);
                        } else {
                            tracing::error!("Failed to parse SDP answer");
                        }
                    }
                    GstCommand::AddIceCandidate {
                        sdp_mline_index,
                        candidate,
                    } => {
                        webrtc.emit_by_name::<()>("add-ice-candidate", &[&sdp_mline_index as &dyn ToValue, &candidate]);
                    }
                    GstCommand::Stop => {
                        break;
                    }
                }
            }
        });

        input_handle
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
        Self::attach_move_data_channel(&move_channel, move_tx.clone());

        let control_channel = webrtcbin
            .emit_by_name::<Option<gst_webrtc::WebRTCDataChannel>>(
                "create-data-channel",
                &[&"mouse-control", &None::<gst::Structure>],
            )
            .expect("Failed to create mouse-control data channel");
        Self::attach_control_data_channel(&control_channel, control_tx.clone());

        input_handle
    }

    fn attach_move_data_channel(
        channel: &gst_webrtc::WebRTCDataChannel,
        move_tx: tokio::sync::watch::Sender<Option<crate::services::input::MouseEvent>>,
    ) {
        channel.connect_on_message_string(move |_, message| {
            let Some(message) = message else {
                return;
            };

            let Ok(event) = serde_json::from_str::<crate::services::input::MouseEvent>(message) else {
                tracing::debug!("Ignoring malformed mouse data-channel message");
                return;
            };

            if event.r#type == "move" {
                let _ = move_tx.send(Some(event));
            }
        });
    }

    fn attach_control_data_channel(
        channel: &gst_webrtc::WebRTCDataChannel,
        control_tx: tokio::sync::mpsc::UnboundedSender<crate::services::input::MouseEvent>,
    ) {
        channel.connect_on_message_string(move |_, message| {
            let Some(message) = message else {
                return;
            };

            let Ok(event) = serde_json::from_str::<crate::services::input::MouseEvent>(message) else {
                tracing::debug!("Ignoring malformed mouse data-channel message");
                return;
            };

            if event.r#type != "move" {
                let _ = control_tx.send(event);
            }
        });
    }

    pub fn stop_stream(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        *self.owner_id.lock() = None;

        if let Some(state) = self.inner.lock().take() {
            let _ = state.cmd_tx.send(GstCommand::Stop);

            let _ = state.pipeline.set_state(gst::State::Null);

            drop(state.pw_handle);
            drop(state.title_handle);
            drop(state.emit_handle);
            if let Some(handle) = state.input_handle {
                handle.abort();
            }
        }

        #[cfg(target_os = "linux")]
        tokio::spawn(async move {
            linux::portal_session().close().await;
        });
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) -> bool {
        let is_owner = self.owner_id.lock().as_deref() == Some(owner_id);
        if is_owner {
            self.stop_stream();
        }
        is_owner
    }

    pub fn update_settings(&self, bitrate: u32, resolution: u8) {
        let bitrate = bitrate.clamp(100, 20000);
        let resolution = resolution.clamp(5, 100);

        {
            let mut s = self.settings.lock();
            s.bitrate = bitrate;
            s.resolution_percentage = resolution;
        }

        if let Some(state) = self.inner.lock().as_ref() {
            state.encoder.set_property_from_str("bitrate", &bitrate.to_string());
        }
    }

    pub fn set_target_fps(&self, fps: u64) {
        let mut s = self.settings.lock();
        s.target_fps = fps.clamp(1, s.max_fps);
    }

    pub fn set_encoder_properties(&self, properties: HashMap<String, String>) -> Vec<String> {
        let rejected = if let Some(state) = self.inner.lock().as_ref() {
            apply_encoder_properties(&state.encoder, &properties)
        } else {
            Vec::new()
        };
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
#[allow(unused_imports)]
pub(crate) use linux::get_active_window_title;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
#[allow(unused_imports)]
use windows::{get_active_window_title, get_display_native_size, get_max_fps, start_os_capture};

pub async fn take_screenshot() -> anyhow::Result<(Vec<u8>, &'static str)> {
    #[cfg(windows)]
    {
        windows::take_screenshot().await
    }
    #[cfg(target_os = "linux")]
    {
        linux::take_screenshot().await
    }
}

fn apply_encoder_properties(encoder: &gst::Element, properties: &HashMap<String, String>) -> Vec<String> {
    let mut rejected = Vec::new();
    for (key, value) in properties {
        tracing::trace!("Setting encoder property {key}={value}");
        let pspec = match encoder.find_property(key) {
            Some(pspec) => pspec,
            None => {
                tracing::warn!("Unknown encoder property: {key}");
                rejected.push(key.clone());
                continue;
            }
        };
        match glib::Value::deserialize_with_pspec(value, &pspec) {
            Ok(v) => {
                encoder.set_property(key, v);
            }
            Err(_) => {
                tracing::warn!("Invalid value for encoder property {key}: {value}");
                rejected.push(key.clone());
            }
        }
    }
    rejected
}

fn detect_max_fps() -> u64 {
    #[cfg(windows)]
    {
        windows::get_max_fps()
    }
    #[cfg(target_os = "linux")]
    {
        linux::get_max_fps()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        60
    }
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
