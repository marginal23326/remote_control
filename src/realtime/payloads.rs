use serde::Serialize;
use ts_rs::TS;

use crate::services::audio::AudioSourceInfo;
use crate::services::camera::CameraDeviceInfo;
use crate::services::tasks::ProcessInfo;

macro_rules! ts_payload {
    ($item:item) => {
        #[derive(Serialize, Debug, TS)]
        #[ts(export, export_to = "bindings.ts")]
        $item
    };
}

ts_payload! {
pub struct MessagePayload {
    pub message: String,
}
}

ts_payload! {
pub struct AuthStatusPayload {
    pub authenticated: bool,
}
}

ts_payload! {
pub struct ShellCreatedPayload {
    pub status: String,
    pub session_id: String,
}
}

ts_payload! {
pub struct ShellOutputPayload {
    pub session_id: String,
    pub output: String,
}
}

ts_payload! {
pub struct ShellClosedPayload {
    pub session_id: String,
}
}

ts_payload! {
pub struct AvailableShellsPayload {
    pub shells: Vec<String>,
    pub default: String,
}
}

ts_payload! {
pub struct AudioSourcesPayload {
    pub sources: Vec<AudioSourceInfo>,
}
}

ts_payload! {
pub struct CameraListPayload {
    pub cameras: Vec<CameraDeviceInfo>,
}
}

ts_payload! {
pub struct ActiveWindowPayload {
    pub title: String,
}
}

ts_payload! {
pub struct AudioFormat {
    pub rate: u32,
    pub channels: u32,
}
}

ts_payload! {
pub struct RemoteIceCandidatePayload {
    pub sdp_mline_index: u32,
    pub candidate: String,
}
}

ts_payload! {
pub struct TaskListPayload {
    pub processes: Vec<ProcessInfo>,
    pub total_cpu_usage: f32,
    pub total_memory_percentage: f64,
}
}
