use crate::realtime::event_names::{ClientEvent, ServerEvent};
use crate::realtime::handlers::{
    handle_camera_webrtc_answer, handle_camera_webrtc_ice, handle_client_audio_data, handle_disconnect,
    handle_keyboard_event, handle_list_audio_sources, handle_list_cameras, handle_list_shells, handle_mouse_event,
    handle_shell_close, handle_shell_create, handle_shell_input, handle_shell_resize, handle_start_camera_stream,
    handle_start_client_audio, handle_start_server_audio, handle_start_stream, handle_stop_camera_stream,
    handle_stop_client_audio, handle_stop_server_audio, handle_task_poll_start, handle_task_poll_stop,
    handle_webrtc_answer, handle_webrtc_ice,
};
use crate::state::AppState;
use crate::utils::auth::is_authenticated;
use serde_json::json;
use socketioxide::{
    SocketIo,
    extract::{SocketRef, State},
};
use tracing::{info, warn};
use ts_rs::TS;

#[derive(serde::Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
struct TaskPayload {
    processes: Vec<crate::services::tasks::ProcessDTO>,
    total_cpu_usage: f32,
    total_memory_percentage: f64,
}

pub fn register(io: SocketIo, state: AppState) {
    io.ns("/", on_connect);

    let io_clone = io.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));

        loop {
            interval.tick().await;

            if crate::realtime::handlers::ACTIVE_WATCHERS.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                continue;
            }

            let state_bg = state.clone();
            let data_res = tokio::task::spawn_blocking(move || {
                let processes = state_bg.tasks.get_processes();

                let (cpu_global, mem_pct) = {
                    let sys = state_bg.sys.read();

                    #[cfg(target_os = "windows")]
                    let cpu = state_bg.tasks.cpu_usage();
                    #[cfg(target_os = "linux")]
                    let cpu = sys.global_cpu_usage();

                    let total_mem = sys.total_memory() as f64;
                    let used_mem = sys.used_memory() as f64;
                    let pct = if total_mem > 0.0 {
                        (used_mem / total_mem) * 100.0
                    } else {
                        0.0
                    };

                    (cpu, pct)
                };

                TaskPayload {
                    processes,
                    total_cpu_usage: cpu_global,
                    total_memory_percentage: mem_pct,
                }
            })
            .await;

            if let Ok(data) = data_res {
                let _ = io_clone
                    .to("task_watchers")
                    .emit(ServerEvent::TaskList.as_str(), &data)
                    .await;
            }
        }
    });
}

async fn on_connect(socket: SocketRef, State(state): State<AppState>) {
    let headers = &socket.req_parts().headers;
    let is_authenticated = is_authenticated(headers, &state.config.jwt_secret);

    if !is_authenticated {
        warn!("Socket connection rejected: Invalid or missing token");
        let _ = socket.emit(ServerEvent::AuthError.as_str(), &json!({ "message": "Unauthorized" }));
        let _ = socket.disconnect();
        return;
    }

    info!("Socket connected & authenticated: {}", socket.id);
    let _ = socket.emit(ServerEvent::AuthStatus.as_str(), &json!({ "authenticated": true }));

    socket.on(ClientEvent::MouseEvent.as_str(), handle_mouse_event);
    socket.on(ClientEvent::KeyboardEvent.as_str(), handle_keyboard_event);

    socket.on(ClientEvent::ShellCreate.as_str(), handle_shell_create);
    socket.on(ClientEvent::ShellInput.as_str(), handle_shell_input);
    socket.on(ClientEvent::ShellResize.as_str(), handle_shell_resize);
    socket.on(ClientEvent::ShellClose.as_str(), handle_shell_close);
    socket.on(ClientEvent::ListShells.as_str(), handle_list_shells);

    socket.on(ClientEvent::TaskPollStart.as_str(), handle_task_poll_start);
    socket.on(ClientEvent::TaskPollStop.as_str(), handle_task_poll_stop);

    socket.on(ClientEvent::ListAudioSources.as_str(), handle_list_audio_sources);
    socket.on(ClientEvent::StartServerAudio.as_str(), handle_start_server_audio);
    socket.on(ClientEvent::StopServerAudio.as_str(), handle_stop_server_audio);
    socket.on(ClientEvent::StartClientAudio.as_str(), handle_start_client_audio);
    socket.on(ClientEvent::StopClientAudio.as_str(), handle_stop_client_audio);
    socket.on(ClientEvent::ClientAudioData.as_str(), handle_client_audio_data);

    socket.on(ClientEvent::StartStream.as_str(), handle_start_stream);

    socket.on(ClientEvent::WebrtcAnswer.as_str(), handle_webrtc_answer);
    socket.on(ClientEvent::WebrtcIceCandidate.as_str(), handle_webrtc_ice);

    socket.on(ClientEvent::ListCameras.as_str(), handle_list_cameras);
    socket.on(ClientEvent::StartCameraStream.as_str(), handle_start_camera_stream);
    socket.on(ClientEvent::StopCameraStream.as_str(), handle_stop_camera_stream);

    socket.on(ClientEvent::CameraWebrtcAnswer.as_str(), handle_camera_webrtc_answer);
    socket.on(ClientEvent::CameraWebrtcIceCandidate.as_str(), handle_camera_webrtc_ice);

    socket.on_disconnect(handle_disconnect);
}
