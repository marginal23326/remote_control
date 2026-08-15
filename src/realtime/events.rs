use crate::realtime::event_names::{ClientEvent, ServerEvent};
use crate::realtime::handlers::{
    handle_camera_webrtc_answer, handle_camera_webrtc_ice, handle_client_audio_data, handle_disconnect,
    handle_keyboard_event, handle_list_audio_sources, handle_list_cameras, handle_list_shells, handle_mouse_event,
    handle_shell_close, handle_shell_create, handle_shell_input, handle_shell_resize, handle_start_camera_stream,
    handle_start_client_audio, handle_start_server_audio, handle_start_stream, handle_stop_camera_stream,
    handle_stop_client_audio, handle_stop_server_audio, handle_task_poll_start, handle_task_poll_stop,
    handle_webrtc_answer, handle_webrtc_ice,
};
use crate::realtime::payloads::{AuthStatusPayload, MessagePayload, TaskPayload};
use crate::state::AppState;
use crate::utils::auth::is_authenticated;
use socketioxide::{
    SocketIo,
    extract::{SocketRef, State},
};
use tracing::{info, warn};

pub fn register(io: SocketIo, state: AppState) {
    io.ns("/", on_connect);
    spawn_task_stats_broadcaster(io, state);
}

fn spawn_task_stats_broadcaster(io: SocketIo, state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));

        loop {
            interval.tick().await;

            if state.task_watchers.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                continue;
            }

            let state_bg = state.clone();
            let data_res = tokio::task::spawn_blocking(move || {
                let processes = state_bg.tasks.get_processes();

                let (cpu_global, mem_pct) = {
                    #[cfg(target_os = "windows")]
                    let cpu = state_bg.tasks.cpu_usage();
                    #[cfg(target_os = "linux")]
                    let cpu = state_bg.tasks.global_cpu_usage();

                    (cpu, state_bg.tasks.memory_usage_percent())
                };

                TaskPayload {
                    processes,
                    total_cpu_usage: cpu_global,
                    total_memory_percentage: mem_pct,
                }
            })
            .await;

            if let Ok(data) = data_res {
                let _ = io.to("task_watchers").emit(ServerEvent::TaskList.as_str(), &data).await;
            }
        }
    });
}

macro_rules! register_handlers {
    ($socket:expr, { $($event:ident => $handler:expr),* $(,)? }) => {
        $( $socket.on(ClientEvent::$event.as_str(), $handler); )*
    };
}

async fn on_connect(socket: SocketRef, State(state): State<AppState>) {
    let headers = &socket.req_parts().headers;
    let is_authenticated = is_authenticated(headers, &state.config.session_token);

    if !is_authenticated {
        warn!("Socket connection rejected: Invalid or missing token");
        let _ = socket.emit(
            ServerEvent::AuthError.as_str(),
            &MessagePayload {
                message: "Unauthorized".to_string(),
            },
        );
        let _ = socket.disconnect();
        return;
    }

    info!("Socket connected & authenticated: {}", socket.id);
    let _ = socket.emit(
        ServerEvent::AuthStatus.as_str(),
        &AuthStatusPayload { authenticated: true },
    );

    register_handlers!(socket, {
        MouseEvent => handle_mouse_event,
        KeyboardEvent => handle_keyboard_event,

        ShellCreate => handle_shell_create,
        ShellInput => handle_shell_input,
        ShellResize => handle_shell_resize,
        ShellClose => handle_shell_close,
        ListShells => handle_list_shells,

        TaskPollStart => handle_task_poll_start,
        TaskPollStop => handle_task_poll_stop,

        ListAudioSources => handle_list_audio_sources,
        StartServerAudio => handle_start_server_audio,
        StopServerAudio => handle_stop_server_audio,
        StartClientAudio => handle_start_client_audio,
        StopClientAudio => handle_stop_client_audio,
        ClientAudioData => handle_client_audio_data,

        StartStream => handle_start_stream,

        WebrtcAnswer => handle_webrtc_answer,
        WebrtcIceCandidate => handle_webrtc_ice,

        ListCameras => handle_list_cameras,
        StartCameraStream => handle_start_camera_stream,
        StopCameraStream => handle_stop_camera_stream,

        CameraWebrtcAnswer => handle_camera_webrtc_answer,
        CameraWebrtcIceCandidate => handle_camera_webrtc_ice,
    });

    socket.on_disconnect(handle_disconnect);
}
