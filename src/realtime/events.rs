use crate::realtime::handlers::{
    handle_client_audio_data, handle_disconnect, handle_keyboard_event, handle_list_audio_sources, handle_list_shells,
    handle_mouse_event, handle_shell_close, handle_shell_create, handle_shell_input, handle_shell_resize,
    handle_start_client_audio, handle_start_server_audio, handle_start_stream, handle_stop_client_audio,
    handle_stop_server_audio, handle_task_poll_start, handle_task_poll_stop, handle_webrtc_answer, handle_webrtc_ice,
};
use crate::state::SharedState;
use crate::utils::auth::is_authenticated;
use serde_json::json;
use socketioxide::{
    SocketIo,
    extract::{SocketRef, State},
};
use tracing::{info, warn};

#[derive(serde::Serialize)]
struct TaskPayload {
    processes: Vec<crate::services::tasks::ProcessDTO>,
    total_cpu_usage: f32,
    total_memory_percentage: f64,
}

pub fn register(io: SocketIo, state: SharedState) {
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
                let _ = io_clone.to("task_watchers").emit("task_list", &data).await;
            }
        }
    });
}

async fn on_connect(socket: SocketRef, State(state): State<SharedState>) {
    let headers = &socket.req_parts().headers;
    let is_authenticated = is_authenticated(headers, &state.config.jwt_secret);

    if !is_authenticated {
        warn!("Socket connection rejected: Invalid or missing token");
        let _ = socket.emit("auth_error", &json!({ "message": "Unauthorized" }));
        let _ = socket.disconnect();
        return;
    }

    info!("Socket connected & authenticated: {}", socket.id);
    let _ = socket.emit("auth_status", &json!({ "authenticated": true }));

    socket.on("mouse_event", handle_mouse_event);
    socket.on("keyboard_event", handle_keyboard_event);

    socket.on("shell_create", handle_shell_create);
    socket.on("shell_input", handle_shell_input);
    socket.on("shell_resize", handle_shell_resize);
    socket.on("shell_close", handle_shell_close);
    socket.on("list_shells", handle_list_shells);

    socket.on("task_poll_start", handle_task_poll_start);
    socket.on("task_poll_stop", handle_task_poll_stop);

    socket.on("list_audio_sources", handle_list_audio_sources);
    socket.on("start_server_audio", handle_start_server_audio);
    socket.on("stop_server_audio", handle_stop_server_audio);
    socket.on("start_client_audio", handle_start_client_audio);
    socket.on("stop_client_audio", handle_stop_client_audio);
    socket.on("client_audio_data", handle_client_audio_data);

    socket.on("start_stream", handle_start_stream);

    socket.on("webrtc_answer", handle_webrtc_answer);
    socket.on("webrtc_ice_candidate", handle_webrtc_ice);

    socket.on_disconnect(handle_disconnect);
}
