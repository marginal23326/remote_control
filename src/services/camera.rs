use crate::realtime::event_names::ServerEvent;
use crate::services::screen::{LEAKY_QUEUE, detect_encoder};
use crate::services::webrtc_session::{
    GstCommand, GstSession, WebRtcSession, WebRtcSignalConfig, spawn_bus_watch, wire_webrtc_signaling,
};
use crate::state::AppState;
use serde::Serialize;
use socketioxide::extract::SocketRef;
use std::sync::atomic::Ordering;
use ts_rs::TS;

use gst::prelude::*;
use gstreamer as gst;

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct CameraDeviceInfo {
    pub id: String,
    pub name: String,
}

struct CameraInner {
    pipeline: gst::Pipeline,
    cmd_tx: crossbeam_channel::Sender<GstCommand>,
}

impl GstSession for CameraInner {
    fn pipeline(&self) -> &gst::Pipeline {
        &self.pipeline
    }

    fn cmd_tx(&self) -> &crossbeam_channel::Sender<GstCommand> {
        &self.cmd_tx
    }
}

pub struct CameraManager {
    session: WebRtcSession<CameraInner>,
}

impl CameraManager {
    pub fn new() -> Self {
        Self {
            session: WebRtcSession::new(),
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
        state: AppState,
        device_id: Option<String>,
    ) -> anyhow::Result<()> {
        let guard = self
            .session
            .ownership()
            .try_start(socket.id.to_string())
            .map_err(|_| anyhow::anyhow!("Webcam is already active on another client"))?;

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
             {LEAKY_QUEUE} ! \
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
                offer_event: ServerEvent::CameraWebrtcOffer.as_str(),
                ice_event: ServerEvent::CameraWebrtcRemoteIce.as_str(),
            },
        );

        let is_running = self.session.ownership().running_flag();
        spawn_bus_watch(pipeline.clone(), "camera", move || {
            is_running.store(false, Ordering::SeqCst);
        });

        if let Err(camera_inner) = self.session.finish_start(CameraInner { pipeline, cmd_tx }) {
            let _ = camera_inner.pipeline.set_state(gst::State::Null);
            return Err(anyhow::anyhow!("Client disconnected during webcam startup"));
        }
        guard.mark_started();

        Ok(())
    }

    pub fn stop_stream(&self) {
        self.session.stop();
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) -> bool {
        self.session.disconnect_if_owner(owner_id)
    }

    pub fn set_remote_description(&self, sdp: String) {
        self.session.set_remote_description(sdp);
    }

    pub fn add_ice_candidate(&self, sdp_mline_index: u32, candidate: String) {
        self.session.add_ice_candidate(sdp_mline_index, candidate);
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
