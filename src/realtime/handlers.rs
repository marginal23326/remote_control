use crate::services::input::{MouseEvent, apply_mouse_event};
use crate::state::SharedState;
use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{Data, SocketRef, State};
use tokio::task::AbortHandle;
use tokio::time::Duration;

// --- DATA STRUCTURES ---

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KeyboardEvent {
    Text {
        text: String,
    },
    Shortcut {
        shortcut: String,
        modifiers: Option<Vec<String>>,
    },
}

#[derive(Deserialize, Debug)]
pub struct ShellCreateEvent {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Deserialize, Debug)]
pub struct ShellInputEvent {
    pub session_id: String,
    pub command: String,
}

#[derive(Deserialize, Debug)]
pub struct ShellResizeEvent {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
struct ActiveShellMarker(String);

#[derive(Debug, Clone)]
struct TaskPollTask {
    handle: AbortHandle,
}

#[derive(Deserialize, Debug)]
pub struct AudioConfig {
    pub source: Option<String>,
    pub rate: Option<u32>,
}

// --- HANDLERS ---

pub async fn handle_mouse_event(Data(data): Data<MouseEvent>, State(state): State<SharedState>) {
    let input = state.input.clone();
    if let Err(err) = apply_mouse_event(input.as_ref(), data).await {
        tracing::error!("Input mouse event failed: {err:#}");
    }
}

pub async fn handle_keyboard_event(Data(data): Data<KeyboardEvent>, State(state): State<SharedState>) {
    let input = state.input.clone();

    let result = match data {
        KeyboardEvent::Text { text } => input.type_text(&text).await,
        KeyboardEvent::Shortcut { shortcut, modifiers } => {
            let mods = modifiers.unwrap_or_default();
            input.send_shortcut(&shortcut, mods).await
        }
    };

    if let Err(err) = result {
        tracing::error!("Input keyboard event failed: {err:#}");
    }
}

pub async fn handle_shell_create(
    socket: SocketRef,
    Data(data): Data<ShellCreateEvent>,
    State(state): State<SharedState>,
) {
    let mut shell_manager = state.shell.lock();

    if let Some(old_session) = socket.extensions.get::<ActiveShellMarker>() {
        shell_manager.close_session(&old_session.0);
    }

    let session_id = uuid::Uuid::new_v4().to_string();

    if let Err(e) = shell_manager.create_session(session_id.clone(), data.cols, data.rows, socket.clone()) {
        tracing::error!("Failed to create shell: {}", e);
        let _ = socket.emit("shell_error", &json!({ "message": e.to_string() }));
        return;
    }

    socket.extensions.insert(ActiveShellMarker(session_id.clone()));

    let _ = socket.emit(
        "shell_created",
        &json!({
            "status": "success",
            "session_id": session_id
        }),
    );
}

pub async fn handle_shell_input(Data(data): Data<ShellInputEvent>, State(state): State<SharedState>) {
    let mut shell_manager = state.shell.lock();
    if let Err(e) = shell_manager.write_to_shell(&data.session_id, &data.command) {
        tracing::error!("Shell write error: {}", e);
    }
}

pub async fn handle_shell_resize(Data(data): Data<ShellResizeEvent>, State(state): State<SharedState>) {
    let mut shell_manager = state.shell.lock();
    if let Err(e) = shell_manager.resize_shell(&data.session_id, data.cols, data.rows) {
        tracing::error!("Shell resize error: {}", e);
    }
}

pub async fn handle_disconnect(socket: SocketRef, State(state): State<SharedState>) {
    if let Some(task) = socket.extensions.remove::<TaskPollTask>() {
        task.handle.abort();
    }

    let mut shell_manager = state.shell.lock();
    if let Some(session) = socket.extensions.remove::<ActiveShellMarker>() {
        shell_manager.close_session(&session.0);
    } else {
        shell_manager.close_session(&socket.id.to_string());
    }

    let socket_id = socket.id.to_string();
    state.screen.disconnect_if_owner(&socket_id);
    state.audio.disconnect_if_owner(&socket_id);

    let input = state.input.clone();
    tokio::spawn(async move {
        let _ = input.click_mouse("left", false).await;
        let _ = input.click_mouse("right", false).await;
        let _ = input.click_mouse("middle", false).await;
    });
}

pub async fn handle_task_poll_start(socket: SocketRef, State(state): State<SharedState>) {
    // 1. Check if a task is already running for this socket and abort it to prevent duplicates
    if let Some(task) = socket.extensions.remove::<TaskPollTask>() {
        task.handle.abort();
    }

    let socket_clone = socket.clone();
    let state_clone = state.clone();

    // 2. Spawn the task and get the JoinHandle
    let join_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));

        loop {
            interval.tick().await;

            let state_bg = state_clone.clone();

            let data_res = tokio::task::spawn_blocking(move || {
                let processes = state_bg.tasks.get_processes();

                let mut sys = state_bg.sys.write();

                #[cfg(target_os = "windows")]
                let cpu_global = state_bg.tasks.cpu_usage();

                #[cfg(target_os = "linux")]
                let cpu_global = {
                    sys.refresh_cpu_usage();
                    sys.global_cpu_usage()
                };

                sys.refresh_memory();

                let total_mem = sys.total_memory() as f64;
                let used_mem = sys.used_memory() as f64;
                let mem_pct = if total_mem > 0.0 {
                    (used_mem / total_mem) * 100.0
                } else {
                    0.0
                };

                json!({
                    "processes": processes,
                    "total_cpu_usage": cpu_global,
                    "total_memory_percentage": mem_pct
                })
            })
            .await;

            // If emit fails (socket closed or blocking task panicked), break the loop
            if let Ok(data) = data_res {
                if socket_clone.emit("task_list", &data).is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });

    // 3. Store the AbortHandle in the socket extensions
    socket.extensions.insert(TaskPollTask {
        handle: join_handle.abort_handle(),
    });
}

pub async fn handle_task_poll_stop(socket: SocketRef) {
    // Retrieve the handle from extensions and abort the task
    if let Some(task) = socket.extensions.remove::<TaskPollTask>() {
        task.handle.abort();
    }
}

pub async fn handle_start_server_audio(
    socket: SocketRef,
    Data(data): Data<AudioConfig>,
    State(state): State<SharedState>,
) {
    let audio = &state.audio;
    let source = data.source.unwrap_or("mic".to_string());
    let rate = data.rate.unwrap_or(48000);

    if let Err(e) = audio.start_server_stream(socket.clone(), source, rate) {
        tracing::error!("Failed to start server audio: {}", e);
    }
}

pub async fn handle_stop_server_audio(socket: SocketRef, State(state): State<SharedState>) {
    state.audio.stop_server_stream_if_owner(&socket.id.to_string());
}

pub async fn handle_start_client_audio(
    socket: SocketRef,
    Data(data): Data<AudioConfig>,
    State(state): State<SharedState>,
) {
    let audio = &state.audio;
    let rate = data.rate.unwrap_or(48000);

    if let Err(e) = audio.start_client_playback(socket.id.to_string(), rate) {
        tracing::error!("Failed to start client playback: {}", e);
    }
}

pub async fn handle_stop_client_audio(socket: SocketRef, State(state): State<SharedState>) {
    state.audio.stop_client_playback_if_owner(&socket.id.to_string());
}

pub async fn handle_client_audio_data(
    Data(data): Data<Vec<u8>>,
    State(state): State<SharedState>,
    ack: socketioxide::extract::AckSender,
) {
    let audio = &state.audio;
    audio.process_client_audio(data);
    let _ = ack.send(&json!({"status": "ok"}));
}

pub async fn handle_start_stream(socket: SocketRef, State(state): State<SharedState>) {
    let screen = state.screen.clone();
    if let Err(e) = screen.start_stream(socket.clone(), state).await {
        tracing::error!("Failed to start stream: {e:#}");
        let _ = socket.emit("stream_error", &json!({ "message": e.to_string() }));
    }
}

pub async fn handle_webrtc_answer(Data(data): Data<serde_json::Value>, State(state): State<SharedState>) {
    let sdp_str = if let Some(s) = data.as_str() {
        s.to_string()
    } else if let Some(s) = data.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()) {
        s.to_string()
    } else {
        return;
    };

    if let Some(inner) = state.screen.inner.lock().as_ref() {
        let _ = inner
            .cmd_tx
            .send(crate::services::screen::GstCommand::SetRemoteDescription(sdp_str));
    }
}

pub async fn handle_webrtc_ice(Data(data): Data<serde_json::Value>, State(state): State<SharedState>) {
    if let (Some(idx), Some(candidate)) = (
        data.get("sdp_mline_index").and_then(|v| v.as_u64()),
        data.get("candidate").and_then(|v| v.as_str()),
    ) && let Some(inner) = state.screen.inner.lock().as_ref()
    {
        let _ = inner.cmd_tx.send(crate::services::screen::GstCommand::AddIceCandidate {
            sdp_mline_index: idx as u32,
            candidate: candidate.to_string(),
        });
    }
}
