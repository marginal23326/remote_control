use crate::services::screen::{GstCommand, WebRtcSignalConfig, detect_encoder, wire_webrtc_signaling};
use crate::state::SharedState;
use parking_lot::Mutex;
use serde::Serialize;
use socketioxide::extract::SocketRef;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

use gst::prelude::*;
use gstreamer as gst;

#[derive(Serialize, Clone, Debug)]
pub struct CameraDeviceInfo {
    pub id: String,
    pub name: String,
}

struct CameraInner {
    pipeline: gst::Pipeline,
    cmd_tx: crossbeam_channel::Sender<GstCommand>,
}

pub struct CameraManager {
    inner: Mutex<Option<CameraInner>>,
    is_running: Arc<AtomicBool>,
    owner_id: Mutex<Option<String>>,
}

struct StartGuard {
    is_running: Arc<AtomicBool>,
    success: bool,
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        if !self.success {
            self.is_running.store(false, Ordering::SeqCst);
        }
    }
}

impl CameraManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            is_running: Arc::new(AtomicBool::new(false)),
            owner_id: Mutex::new(None),
        }
    }

    pub fn list_cameras() -> Vec<CameraDeviceInfo> {
        let _ = gst::init();
        enumerate_devices()
            .iter()
            .map(|d| {
                let name = d.display_name().to_string();
                CameraDeviceInfo { id: name.clone(), name }
            })
            .collect()
    }

    pub async fn start_stream(
        &self,
        socket: SocketRef,
        state: SharedState,
        device_id: Option<String>,
    ) -> anyhow::Result<()> {
        if self
            .is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(anyhow::anyhow!("Already active"));
        }

        *self.owner_id.lock() = Some(socket.id.to_string());

        let mut guard = StartGuard {
            is_running: self.is_running.clone(),
            success: false,
        };

        gst::init()?;

        let devices = enumerate_devices();
        let device = match device_id.as_deref() {
            Some(id) => devices.into_iter().find(|d| d.display_name() == id),
            None => devices.into_iter().next(),
        }
        .ok_or_else(|| anyhow::anyhow!("No webcam found"))?;

        let src = device.create_element(Some("src"))?;

        let encoder_info = detect_encoder();

        let rest_desc = format!(
            "videoconvert ! \
             video/x-raw,format=NV12 ! \
             queue leaky=downstream max-size-buffers=2 max-size-time=0 max-size-bytes=0 ! \
             {} ! \
             rtph264pay config-interval=-1 aggregate-mode=zero-latency ! \
             webrtcbin name=webrtc bundle-policy=max-bundle latency=0",
            encoder_info.pipeline_str
        );

        let rest = gst::parse::bin_from_description(&rest_desc, true)?;

        let pipeline = gst::Pipeline::new();
        pipeline.add(&src)?;
        pipeline.add(&rest)?;
        src.link(&rest)?;

        let webrtcbin = pipeline
            .by_name("webrtc")
            .ok_or_else(|| anyhow::anyhow!("webrtcbin not found"))?;

        if let Some(encoder) = pipeline.by_name("enc") {
            encoder.set_property_from_str("bitrate", "2000");
        }

        pipeline.set_state(gst::State::Ready)?;

        let (cmd_tx, cmd_rx) = crossbeam_channel::bounded::<GstCommand>(32);

        wire_webrtc_signaling(
            &webrtcbin,
            cmd_rx,
            socket.clone(),
            state.config.stun_server.clone(),
            WebRtcSignalConfig {
                label: "camera",
                offer_event: "camera_webrtc_offer",
                ice_event: "camera_webrtc_remote_ice",
            },
        );

        let is_running = self.is_running.clone();
        let pipeline_clone = pipeline.clone();
        let pipeline_weak = pipeline_clone.downgrade();

        thread::spawn(move || {
            let res = pipeline_clone.set_state(gst::State::Playing);
            tracing::debug!("Camera pipeline state set to Playing: {res:?}");
            for msg in pipeline_clone.bus().unwrap().iter_timed(None::<gst::ClockTime>) {
                use gst::MessageView;
                match msg.view() {
                    MessageView::Eos(..) => {
                        tracing::info!("Camera pipeline bus: EOS");
                        break;
                    }
                    MessageView::Error(err) => {
                        tracing::error!("Camera pipeline bus error: {}", err.error());
                        if let Some(dbg) = err.debug() {
                            tracing::error!("  Debug: {dbg}");
                        }
                        break;
                    }
                    MessageView::Warning(warn) => {
                        tracing::warn!("Camera pipeline bus warning: {}", warn.error());
                    }
                    _ => {}
                }
            }
            let _ = pipeline_weak.upgrade().map(|p| p.set_state(gst::State::Null));
            is_running.store(false, Ordering::SeqCst);
        });

        if !self.is_running.load(Ordering::SeqCst) {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(anyhow::anyhow!("Client disconnected during webcam startup"));
        }

        *self.inner.lock() = Some(CameraInner { pipeline, cmd_tx });
        guard.success = true;

        Ok(())
    }

    pub fn stop_stream(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        *self.owner_id.lock() = None;

        if let Some(state) = self.inner.lock().take() {
            let _ = state.cmd_tx.send(GstCommand::Stop);
            let _ = state.pipeline.set_state(gst::State::Null);
        }
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) -> bool {
        let is_owner = self.owner_id.lock().as_deref() == Some(owner_id);
        if is_owner {
            self.stop_stream();
        }
        is_owner
    }

    pub fn set_remote_description(&self, sdp: String) {
        if let Some(inner) = self.inner.lock().as_ref() {
            let _ = inner.cmd_tx.send(GstCommand::SetRemoteDescription(sdp));
        }
    }

    pub fn add_ice_candidate(&self, sdp_mline_index: u32, candidate: String) {
        if let Some(inner) = self.inner.lock().as_ref() {
            let _ = inner.cmd_tx.send(GstCommand::AddIceCandidate {
                sdp_mline_index,
                candidate,
            });
        }
    }
}

fn enumerate_devices() -> Vec<gst::Device> {
    let monitor = gst::DeviceMonitor::new();
    monitor.add_filter(Some("Video/Source"), None);
    if monitor.start().is_err() {
        return Vec::new();
    }
    let devices: Vec<gst::Device> = monitor.devices().into_iter().collect();
    monitor.stop();

    devices
        .into_iter()
        .filter(|d| d.properties().is_some_and(|p| p.get::<String>("device.api").is_ok()))
        .collect()
}
