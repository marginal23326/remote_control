use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Sender, bounded};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;

#[derive(Clone, Copy, Debug)]
pub struct StreamSettings {
    pub bitrate: u32,
    pub resolution_percentage: u8,
    pub target_fps: u64,
    pub max_fps: u64,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            bitrate: 5000,
            resolution_percentage: 100,
            target_fps: 60,
            max_fps: 60,
        }
    }
}

pub(crate) struct RawFrame {
    pub buffer: Vec<u8>,
    pub width: u32,
    pub height: u32,
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

        if self.accumulated < interval {
            false
        } else {
            self.accumulated -= interval;
            true
        }
    }
}

pub(crate) enum GstCommand {
    SetRemoteDescription(String),
    AddIceCandidate {
        sdp_mline_index: u32,
        candidate: String,
    },
    Stop,
}

struct EncoderInfo {
    pipeline_str: &'static str,
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
                pipeline_str: "mfh264enc name=enc low-latency=true rc-mode=0 gop-size=30 ref=1",
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
                pipeline_str: "vah264enc name=enc target-usage=7 rate-control=cbr key-int-max=30 ref-frames=1 cpb-size=100",
                min_dim: 128,
            };
        }
    }

    tracing::warn!("No hardware encoder found. Falling back to CPU (x264enc)");
    EncoderInfo {
        pipeline_str: "x264enc name=enc tune=zerolatency speed-preset=ultrafast",
        min_dim: 2,
    }
}

pub struct ScreenManager {
    pub settings: Arc<Mutex<StreamSettings>>,
    pub native_size: Arc<Mutex<(i32, i32)>>,
    pub(crate) inner: Mutex<Option<InnerState>>,
    is_running: Arc<AtomicBool>,
}

pub(crate) struct InnerState {
    pub(crate) pipeline: gst::Pipeline,
    pub(crate) encoder: gst::Element,
    pub(crate) cmd_tx: crossbeam_channel::Sender<GstCommand>,
    pw_handle: Option<thread::JoinHandle<()>>,
    title_handle: Option<thread::JoinHandle<()>>,
    emit_handle: Option<thread::JoinHandle<()>>,
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
            is_running: Arc::new(AtomicBool::new(false)),
            inner: Mutex::new(None),
        }
    }

    pub async fn start_stream(
        &self,
        socket: socketioxide::extract::SocketRef,
        _state: crate::state::SharedState,
    ) -> anyhow::Result<()> {
        if self.is_running.load(Ordering::SeqCst) {
            tracing::warn!("start_stream: already running");
            return Ok(());
        }

        gst::init().map_err(|e| anyhow::anyhow!("GStreamer init failed: {e}"))?;

        let encoder_info = detect_encoder();
        let encoder_str = encoder_info.pipeline_str;
        let min_dim = encoder_info.min_dim;

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

        let default_bitrate = self.settings.lock().unwrap().bitrate;
        encoder.set_property_from_str("bitrate", &default_bitrate.to_string());

        let (cmd_tx, cmd_rx) = bounded::<GstCommand>(32);

        let (frame_tx, frame_rx): (Sender<RawFrame>, _) = bounded(3);
        let (recycle_tx, recycle_rx): (Sender<Vec<u8>>, _) = bounded(5);

        let socket_signal = socket.clone();
        Self::setup_webrtc_signals(&webrtcbin, &cmd_rx, socket_signal);

        self.is_running.store(true, Ordering::SeqCst);
        let is_running = self.is_running.clone();
        let settings = self.settings.clone();

        let pipeline_clone = pipeline.clone();
        let pipeline_weak = pipeline_clone.downgrade();

        thread::spawn(move || {
            let res = pipeline_clone.set_state(gst::State::Playing);
            tracing::debug!("Pipeline state set to Playing: {res:?}");
            for msg in pipeline_clone
                .bus()
                .unwrap()
                .iter_timed(None::<gst::ClockTime>)
            {
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
            let _ = pipeline_weak
                .upgrade()
                .map(|p| p.set_state(gst::State::Null));
        });

        #[cfg(target_os = "linux")]
        let mut inner = {
            let (pw_node_id, pw_size, pw_fd) = {
                let portal = linux::portal_session();
                portal.open_pipewire_remote().await
            }?;
            *self.native_size.lock().unwrap() = pw_size;

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
                        let _ =
                            socket_emit.emit("active_window", &serde_json::json!({"title": &last}));
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            })
        };

        let is_running_enc = is_running.clone();
        let settings_enc = settings.clone();
        let frame_rx_enc = frame_rx;

        thread::spawn(move || {
            use fast_image_resize::{
                PixelType, ResizeAlg, ResizeOptions, Resizer,
                images::{Image, ImageRef},
            };

            let mut resizer = Resizer::new();

            while is_running_enc.load(Ordering::SeqCst) {
                let Ok(mut raw) = frame_rx_enc.recv_timeout(Duration::from_millis(100)) else {
                    continue;
                };

                if !is_running_enc.load(Ordering::SeqCst) {
                    break;
                }

                let scale_pct = settings_enc.lock().unwrap().resolution_percentage;

                if scale_pct < 100 {
                    let new_w = ((raw.width * scale_pct as u32 / 100).max(min_dim) / 2) * 2;
                    let new_h = ((raw.height * scale_pct as u32 / 100).max(min_dim) / 2) * 2;
                    let required = (new_w * new_h * 4) as usize;

                    let mut final_buf = vec![0u8; required];

                    let src =
                        ImageRef::new(raw.width, raw.height, &raw.buffer, PixelType::U8x4).unwrap();
                    let mut dst =
                        Image::from_slice_u8(new_w, new_h, &mut final_buf, PixelType::U8x4)
                            .unwrap();
                    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Nearest);
                    if resizer.resize(&src, &mut dst, &opts).is_ok() {
                        let old_buf = std::mem::replace(&mut raw.buffer, final_buf);
                        let _ = recycle_tx.try_send(old_buf);
                        raw.width = new_w;
                        raw.height = new_h;
                    }
                }

                let caps = gst::Caps::builder("video/x-raw")
                    .field("format", "BGRA")
                    .field("width", raw.width as i32)
                    .field("height", raw.height as i32)
                    .build();
                appsrc.set_caps(Some(&caps));

                let buffer = gst::Buffer::from_mut_slice(raw.buffer);
                if appsrc.push_buffer(buffer).is_err() {
                    tracing::debug!("Appsrc: push_buffer failed (shutting down?)");
                    break;
                }
            }
        });

        inner.emit_handle = Some(emit_handle);
        *self.inner.lock().unwrap() = Some(inner);

        Ok(())
    }

    fn setup_webrtc_signals(
        webrtcbin: &gst::Element,
        cmd_rx: &crossbeam_channel::Receiver<GstCommand>,
        socket: socketioxide::extract::SocketRef,
    ) {
        let wtc = webrtcbin.clone();

        webrtcbin.set_property_from_str("stun-server", "stun://stun.l.google.com:19302");

        {
            let socket_nego = socket.clone();
            wtc.connect("on-negotiation-needed", false, move |args| {
                let webrtc: gst::Element = args[0].get().unwrap();
                let socket = socket_nego.clone();
                let webrtc_promise = webrtc.clone();

                let promise = gst::Promise::with_change_func(move |reply| {
                    if let Ok(Some(structure)) = reply
                        && let Ok(offer) =
                            structure.get::<gst_webrtc::WebRTCSessionDescription>("offer")
                        && let Ok(sdp_text) = offer.sdp().as_text()
                    {
                        webrtc_promise.emit_by_name::<()>(
                            "set-local-description",
                            &[&offer, &None::<gst::Promise>],
                        );
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

        let cmd_rx_clone = cmd_rx.clone();
        let webrtc = wtc.clone();
        thread::spawn(move || {
            while let Ok(cmd) = cmd_rx_clone.recv() {
                match cmd {
                    GstCommand::SetRemoteDescription(sdp_text) => {
                        if let Ok(sdp) = gst_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes()) {
                            let desc = gst_webrtc::WebRTCSessionDescription::new(
                                gst_webrtc::WebRTCSDPType::Answer,
                                sdp,
                            );
                            webrtc.emit_by_name::<()>(
                                "set-remote-description",
                                &[&desc, &None::<gst::Promise>],
                            );
                        } else {
                            tracing::error!("Failed to parse SDP answer");
                        }
                    }
                    GstCommand::AddIceCandidate {
                        sdp_mline_index,
                        candidate,
                    } => {
                        webrtc.emit_by_name::<()>(
                            "add-ice-candidate",
                            &[&sdp_mline_index as &dyn ToValue, &candidate],
                        );
                    }
                    GstCommand::Stop => {
                        break;
                    }
                }
            }
        });
    }

    pub fn stop_stream(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        if let Some(state) = self.inner.lock().unwrap().take() {
            let _ = state.cmd_tx.send(GstCommand::Stop);

            if let Some(src) = state.pipeline.by_name("src") {
                if let Ok(appsrc) = src.dynamic_cast::<gst_app::AppSrc>() {
                    let _ = appsrc.end_of_stream();
                }
            }

            drop(state.pw_handle);
            drop(state.title_handle);
            drop(state.emit_handle);
        }
    }

    pub fn update_settings(&self, bitrate: u32, resolution: u8) {
        let bitrate = bitrate.clamp(100, 20000);
        let resolution = resolution.clamp(5, 100);

        {
            let mut s = self.settings.lock().unwrap();
            s.bitrate = bitrate;
            s.resolution_percentage = resolution;
        }

        if let Some(state) = self.inner.lock().unwrap().as_ref() {
            state
                .encoder
                .set_property_from_str("bitrate", &bitrate.to_string());
        }
    }

    pub fn set_target_fps(&self, fps: u64) {
        let mut s = self.settings.lock().unwrap();
        s.target_fps = fps.clamp(1, s.max_fps);
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

fn detect_max_fps() -> u64 {
    #[cfg(windows)]
    {
        windows::get_max_fps()
    }
    #[cfg(not(windows))]
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

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("remote-control screen capture is only implemented for Windows and Linux.");
