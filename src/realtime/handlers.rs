use crate::services::camera::CameraManager;
use crate::services::input::{MouseEvent, apply_mouse_event};
use crate::state::SharedState;
use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{Data, SocketRef, State};
use std::sync::atomic::{AtomicUsize, Ordering};
use ts_rs::TS;

pub static ACTIVE_WATCHERS: AtomicUsize = AtomicUsize::new(0);

// --- DATA STRUCTURES ---

#[derive(Deserialize, Debug, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "bindings.ts", optional_fields)]
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

#[derive(Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields)]
pub struct ShellCreateEvent {
    pub cols: u16,
    pub rows: u16,
    pub session_id: String,
    #[serde(default)]
    pub shell: Option<String>,
}

#[derive(Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct ShellInputEvent {
    pub command: String,
}

#[derive(Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct ShellResizeEvent {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
struct TaskPollMarker;

#[derive(Debug, Clone)]
struct ShellPendingMarker;

#[derive(Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields = nullable)]
pub struct AudioConfig {
    pub source: Option<String>,
    pub rate: Option<u32>,
    pub device_id: Option<String>,
}

#[derive(Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields = nullable)]
pub struct CameraStartConfig {
    pub device_id: Option<String>,
}

#[derive(Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields)]
pub struct StartStreamConfig {
    pub capture_cursor: Option<bool>,
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
    state.camera.disconnect_if_owner(&socket_id);

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
        let _ = socket.emit("server_audio_error", &json!({ "message": e }));
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
        let _ = socket.emit("client_audio_error", &json!({ "message": e }));
    }
}

pub async fn handle_stop_client_audio(socket: SocketRef, State(state): State<SharedState>) {
    state.audio.stop_client_playback_if_owner(&socket.id.to_string());
}

pub async fn handle_client_audio_data(
    socket: SocketRef,
    Data(data): Data<bytes::Bytes>,
    State(state): State<SharedState>,
) {
    state.audio.process_client_audio(&socket.id.to_string(), data.to_vec());
}

pub async fn handle_start_stream(
    socket: SocketRef,
    Data(data): Data<StartStreamConfig>,
    State(state): State<SharedState>,
) {
    let screen = state.screen.clone();
    if let Err(e) = screen
        .start_stream(socket.clone(), state, data.capture_cursor.unwrap_or(true))
        .await
    {
        tracing::error!("Failed to start: {e:#}");
        let _ = socket.emit("stream_error", &json!({ "message": e.to_string() }));
    }
}

pub async fn handle_list_cameras(socket: SocketRef) {
    let cameras = tokio::task::spawn_blocking(CameraManager::list_cameras)
        .await
        .unwrap_or_default();
    let _ = socket.emit("camera_list", &json!({ "cameras": cameras }));
}

pub async fn handle_start_camera_stream(
    socket: SocketRef,
    Data(data): Data<CameraStartConfig>,
    State(state): State<SharedState>,
) {
    let camera = state.camera.clone();
    if let Err(e) = camera.start_stream(socket.clone(), state, data.device_id).await {
        tracing::error!("Failed to start: {e:#}");
        let _ = socket.emit("camera_stream_error", &json!({ "message": e.to_string() }));
    }
}

pub async fn handle_stop_camera_stream(State(state): State<SharedState>) {
    state.camera.stop_stream();
}

fn extract_sdp(data: &serde_json::Value) -> Option<String> {
    data.as_str()
        .or_else(|| data.as_array()?.first()?.as_str())
        .map(str::to_string)
}

fn extract_ice(data: &serde_json::Value) -> Option<(u32, String)> {
    Some((
        data.get("sdp_mline_index")?.as_u64()? as u32,
        data.get("candidate")?.as_str()?.to_string(),
    ))
}

macro_rules! webrtc_signal_handlers {
    ($answer_fn:ident, $ice_fn:ident, $manager:ident) => {
        pub async fn $answer_fn(Data(data): Data<serde_json::Value>, State(state): State<SharedState>) {
            let Some(sdp_str) = extract_sdp(&data) else { return };
            state.$manager.set_remote_description(sdp_str);
        }

        pub async fn $ice_fn(Data(data): Data<serde_json::Value>, State(state): State<SharedState>) {
            let Some((sdp_mline_index, candidate)) = extract_ice(&data) else {
                return;
            };
            state.$manager.add_ice_candidate(sdp_mline_index, candidate);
        }
    };
}

webrtc_signal_handlers!(handle_webrtc_answer, handle_webrtc_ice, screen);
webrtc_signal_handlers!(handle_camera_webrtc_answer, handle_camera_webrtc_ice, camera);
