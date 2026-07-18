use std::thread;

use crossbeam_channel::{Receiver, Sender};
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use parking_lot::Mutex;
use socketioxide::extract::SocketRef;

use super::owned_worker::StreamOwnership;

pub(crate) enum GstCommand {
    SetRemoteDescription(String),
    AddIceCandidate { sdp_mline_index: u32, candidate: String },
    Stop,
}

pub(crate) struct WebRtcSignalConfig {
    pub label: &'static str,
    pub offer_event: &'static str,
    pub ice_event: &'static str,
}

pub(crate) fn wire_webrtc_signaling(
    webrtcbin: &gst::Element,
    cmd_rx: Receiver<GstCommand>,
    socket: SocketRef,
    stun_server: Option<String>,
    config: WebRtcSignalConfig,
) {
    if let Some(stun) = stun_server
        && !stun.is_empty()
    {
        webrtcbin.set_property_from_str("stun-server", &stun);
    }

    {
        let socket_nego = socket.clone();
        let offer_event = config.offer_event;
        webrtcbin.connect("on-negotiation-needed", false, move |args| {
            let webrtc: gst::Element = args[0].get().unwrap();
            let socket = socket_nego.clone();
            let webrtc_promise = webrtc.clone();

            let promise = gst::Promise::with_change_func(move |reply| {
                if let Ok(Some(structure)) = reply
                    && let Ok(offer) = structure.get::<gst_webrtc::WebRTCSessionDescription>("offer")
                    && let Ok(sdp_text) = offer.sdp().as_text()
                {
                    webrtc_promise.emit_by_name::<()>("set-local-description", &[&offer, &None::<gst::Promise>]);
                    let _ = socket.emit(offer_event, &sdp_text);
                }
            });

            webrtc.emit_by_name::<()>("create-offer", &[&None::<gst::Structure>, &promise]);
            None
        });
    }

    {
        let socket_ice = socket.clone();
        let ice_event = config.ice_event;
        webrtcbin.connect("on-ice-candidate", false, move |args| {
            let sdp_mline_index: u32 = args[1].get().unwrap();
            let candidate: String = args[2].get().unwrap();
            let data = serde_json::json!({
                "sdp_mline_index": sdp_mline_index,
                "candidate": candidate,
            });
            let _ = socket_ice.emit(ice_event, &data);
            None
        });
    }

    let webrtc = webrtcbin.clone();
    let label = config.label;
    thread::spawn(move || {
        while let Ok(cmd) = cmd_rx.recv() {
            match cmd {
                GstCommand::SetRemoteDescription(sdp_text) => {
                    if let Ok(sdp) = gst_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes()) {
                        let desc = gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Answer, sdp);
                        webrtc.emit_by_name::<()>("set-remote-description", &[&desc, &None::<gst::Promise>]);
                    } else {
                        tracing::error!("[{label}] Failed to parse SDP answer");
                    }
                }
                GstCommand::AddIceCandidate {
                    sdp_mline_index,
                    candidate,
                } => {
                    webrtc.emit_by_name::<()>("add-ice-candidate", &[&sdp_mline_index as &dyn ToValue, &candidate]);
                }
                GstCommand::Stop => break,
            }
        }
    });
}

pub(crate) fn spawn_bus_watch(
    pipeline: gst::Pipeline,
    label: &'static str,
    on_exit: impl FnOnce() + Send + 'static,
) -> thread::JoinHandle<()> {
    let pipeline_weak = pipeline.downgrade();

    thread::spawn(move || {
        let _ = pipeline.set_state(gst::State::Playing);
        for msg in pipeline.bus().unwrap().iter_timed(None::<gst::ClockTime>) {
            use gst::MessageView;
            match msg.view() {
                MessageView::Eos(..) => {
                    tracing::info!("[{label}] Pipeline bus: EOS");
                    break;
                }
                MessageView::Error(err) => {
                    tracing::error!("[{label}] Pipeline bus error: {}", err.error());
                    if let Some(dbg) = err.debug() {
                        tracing::error!("  Debug: {dbg}");
                    }
                    break;
                }
                MessageView::Warning(warn) => {
                    tracing::warn!("[{label}] Pipeline bus warning: {}", warn.error());
                    if let Some(dbg) = warn.debug() {
                        tracing::warn!("  Warn debug: {dbg}");
                    }
                }
                _ => {}
            }
        }
        let _ = pipeline_weak.upgrade().map(|p| p.set_state(gst::State::Null));
        on_exit();
    })
}

pub(crate) trait GstSession: Sized {
    fn pipeline(&self) -> &gst::Pipeline;
    fn cmd_tx(&self) -> &Sender<GstCommand>;
    fn on_stop(self) {}
}

pub(crate) struct WebRtcSession<T: GstSession> {
    inner: Mutex<Option<T>>,
    ownership: StreamOwnership,
}

impl<T: GstSession> WebRtcSession<T> {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            ownership: StreamOwnership::new(),
        }
    }

    pub(crate) fn ownership(&self) -> &StreamOwnership {
        &self.ownership
    }

    pub(crate) fn finish_start(&self, state: T) -> Result<(), T> {
        let mut guard = self.inner.lock();
        if !self.ownership.is_running() {
            return Err(state);
        }
        *guard = Some(state);
        Ok(())
    }

    pub(crate) fn with_inner<R>(&self, f: impl FnOnce(&T) -> R) -> Option<R> {
        self.inner.lock().as_ref().map(f)
    }

    pub(crate) fn stop(&self) {
        self.ownership.clear();

        if let Some(state) = self.inner.lock().take() {
            let _ = state.cmd_tx().send(GstCommand::Stop);
            let _ = state.pipeline().set_state(gst::State::Null);
            state.on_stop();
        }
    }

    pub(crate) fn disconnect_if_owner(&self, owner_id: &str) -> bool {
        let is_owner = self.ownership.owns(owner_id);
        if is_owner {
            self.stop();
        }
        is_owner
    }

    pub(crate) fn set_remote_description(&self, sdp: String) {
        self.with_inner(|s| {
            let _ = s.cmd_tx().send(GstCommand::SetRemoteDescription(sdp));
        });
    }

    pub(crate) fn add_ice_candidate(&self, sdp_mline_index: u32, candidate: String) {
        self.with_inner(|s| {
            let _ = s.cmd_tx().send(GstCommand::AddIceCandidate {
                sdp_mline_index,
                candidate,
            });
        });
    }
}
