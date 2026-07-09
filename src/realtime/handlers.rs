use crate::services::input::{MouseEvent, apply_mouse_event};
use crate::state::SharedState;
use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{Data, SocketRef, State};
use std::sync::atomic::{AtomicUsize, Ordering};

pub static ACTIVE_WATCHERS: AtomicUsize = AtomicUsize::new(0);

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
    KeyDown {
        key: String,
    },
    KeyUp {
        key: String,
    },
}

#[derive(Deserialize, Debug)]
pub struct ShellCreateEvent {
    pub cols: u16,
    pub rows: u16,
    pub session_id: String,
    #[serde(default)]
    pub shell: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ShellInputEvent {
    pub command: String,
}

#[derive(Deserialize, Debug)]
pub struct ShellResizeEvent {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
struct TaskPollMarker;

#[derive(Debug, Clone)]
struct ShellPendingMarker;

#[derive(Deserialize, Debug)]
pub struct AudioConfig {
    pub source: Option<String>,
    pub rate: Option<u32>,
    pub device_id: Option<String>,
}

// --- HANDLERS ---

pub async fn handle_mouse_event(Data(data): Data<MouseEvent>, State(state): State<SharedState>) {
    apply_mouse_event(&state.input, data).await;
}

pub async fn handle_keyboard_event(Data(data): Data<KeyboardEvent>, State(state): State<SharedState>) {
    match data {
        KeyboardEvent::Text { text } => state.input.type_text(&text).await,
        KeyboardEvent::Shortcut { shortcut, modifiers } => {
            let mods = modifiers.unwrap_or_default();
            state.input.send_shortcut(&shortcut, mods).await
        }
        KeyboardEvent::KeyDown { key } => state.input.set_key_state(&key, true).await,
        KeyboardEvent::KeyUp { key } => state.input.set_key_state(&key, false).await,
    };
}

pub async fn handle_shell_create(
    socket: SocketRef,
    Data(data): Data<ShellCreateEvent>,
    State(state): State<SharedState>,
) {
    let socket_id = socket.id.to_string();

    if socket.extensions.insert(ShellPendingMarker).is_some() {
        return;
    }

    state.shell.close_session(&socket_id);

    let session_id = data.session_id;
    let sid = session_id.clone();
    let socket_clone = socket.clone();
    let cols = data.cols;
    let rows = data.rows;
    let shell = data.shell;
    let shell_manager = state.shell.clone();
    let socket_id_for_create = socket_id.clone();

    let session_result = tokio::task::spawn_blocking(move || {
        shell_manager.create_session(&socket_id_for_create, &sid, cols, rows, shell.as_deref(), socket_clone)
    })
    .await
    .unwrap();

    socket.extensions.remove::<ShellPendingMarker>();

    match session_result {
        Ok(session) => {
            if socket.connected() {
                state.shell.add_session(socket_id, session);
                let _ = socket.emit(
                    "shell_created",
                    &json!({ "status": "success", "session_id": session_id }),
                );
            } else {
                std::thread::spawn(move || drop(session));
            }
        }
        Err(e) => {
            tracing::error!("Failed to create shell: {}", e);
            let _ = socket.emit("shell_error", &json!({ "message": e.to_string() }));
        }
    }
}

pub async fn handle_shell_input(
    socket: SocketRef,
    Data(data): Data<ShellInputEvent>,
    State(state): State<SharedState>,
) {
    if let Err(e) = state.shell.write_to_shell(&socket.id.to_string(), &data.command) {
        tracing::error!("Shell write error: {}", e);
    }
}

pub async fn handle_shell_resize(
    socket: SocketRef,
    Data(data): Data<ShellResizeEvent>,
    State(state): State<SharedState>,
) {
    if let Err(e) = state.shell.resize_shell(&socket.id.to_string(), data.cols, data.rows) {
        tracing::error!("Shell resize error: {}", e);
    }
}

pub async fn handle_shell_close(socket: SocketRef, State(state): State<SharedState>) {
    state.shell.close_session(&socket.id.to_string());
}

pub async fn handle_list_shells(socket: SocketRef, State(state): State<SharedState>) {
    let shell = state.shell.clone();
    let (shells, default) = tokio::task::spawn_blocking(move || shell.list_available_shells())
        .await
        .unwrap_or_default();

    let _ = socket.emit("available_shells", &json!({ "shells": shells, "default": default }));
}

pub async fn handle_disconnect(socket: SocketRef, State(state): State<SharedState>) {
    if socket.extensions.remove::<TaskPollMarker>().is_some() {
        ACTIVE_WATCHERS.fetch_sub(1, Ordering::SeqCst);
    }

    state.shell.close_session(&socket.id.to_string());

    let socket_id = socket.id.to_string();
    let was_screen_owner = state.screen.disconnect_if_owner(&socket_id);
    state.audio.disconnect_if_owner(&socket_id);

    if was_screen_owner {
        let input = state.input.clone();
        tokio::spawn(async move {
            input.click_mouse("left", false).await;
            input.click_mouse("right", false).await;
            input.click_mouse("middle", false).await;
        });
    }
}

pub async fn handle_task_poll_start(socket: SocketRef) {
    if socket.extensions.insert(TaskPollMarker).is_none() {
        ACTIVE_WATCHERS.fetch_add(1, Ordering::SeqCst);
        socket.join("task_watchers");
    }
}

pub async fn handle_task_poll_stop(socket: SocketRef) {
    if socket.extensions.remove::<TaskPollMarker>().is_some() {
        ACTIVE_WATCHERS.fetch_sub(1, Ordering::SeqCst);
        socket.leave("task_watchers");
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
    let device_id = data.device_id.filter(|id| !id.is_empty());

    if let Err(e) = audio.start_server_stream(socket.clone(), source, device_id, rate) {
        tracing::error!("Failed to start server audio: {}", e);
    }
}

pub async fn handle_list_audio_sources(socket: SocketRef, State(state): State<SharedState>) {
    let audio = state.audio.clone();
    let sources = tokio::task::spawn_blocking(move || audio.list_sources()).await.unwrap();

    match sources {
        Ok(sources) => {
            let _ = socket.emit("audio_sources", &json!({ "sources": sources }));
        }
        Err(e) => {
            tracing::error!("Failed to list audio sources: {}", e);
            let _ = socket.emit("audio_sources_error", &json!({ "message": e }));
        }
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

pub async fn handle_client_audio_data(Data(data): Data<bytes::Bytes>, State(state): State<SharedState>) {
    let audio = &state.audio;
    audio.process_client_audio(data.to_vec());
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
