use crate::realtime::event_names::ServerEvent;
use crate::realtime::payloads::{
    AudioSourcesPayload, AvailableShellsPayload, CameraListPayload, MessagePayload, ShellCreatedPayload,
};
use crate::services::audio::{AudioManager, AudioSourceKind};
use crate::services::camera::CameraManager;
use crate::services::input::{MouseButton, MouseEventPayload, apply_mouse_event};
use crate::services::webrtc_session::WebRtcManager;
use crate::state::AppState;
use crate::utils::blocking::{run, run_or_log_default};
use serde::Deserialize;
use socketioxide::extract::{Data, SocketRef, State};
use std::sync::atomic::Ordering;
use ts_rs::TS;

// --- DATA STRUCTURES ---

#[derive(Deserialize, Debug, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "bindings.ts", optional_fields)]
pub enum KeyboardEventPayload {
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
    pub source: Option<AudioSourceKind>,
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

fn emit_error(socket: &SocketRef, event: ServerEvent, action: &str, err: impl std::fmt::Display) {
    tracing::error!("Failed to {action}: {err:#}");
    let _ = socket.emit(
        event.as_str(),
        &MessagePayload {
            message: err.to_string(),
        },
    );
}

pub async fn handle_mouse_event(Data(data): Data<MouseEventPayload>, State(state): State<AppState>) {
    apply_mouse_event(&state.input, data).await;
}

pub async fn handle_keyboard_event(Data(data): Data<KeyboardEventPayload>, State(state): State<AppState>) {
    match data {
        KeyboardEventPayload::Text { text } => state.input.type_text(text).await,
        KeyboardEventPayload::Shortcut { shortcut, modifiers } => {
            let mods = modifiers.unwrap_or_default();
            state.input.send_shortcut(shortcut, mods).await
        }
        KeyboardEventPayload::KeyDown { key } => state.input.set_key_state(key, true).await,
        KeyboardEventPayload::KeyUp { key } => state.input.set_key_state(key, false).await,
    };
}

pub async fn handle_shell_create(socket: SocketRef, Data(data): Data<ShellCreateEvent>, State(state): State<AppState>) {
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

    let session_result = run(move || {
        shell_manager.create_session(&socket_id_for_create, &sid, cols, rows, shell.as_deref(), socket_clone)
    })
    .await;

    socket.extensions.remove::<ShellPendingMarker>();

    match session_result {
        Ok(session) => {
            if socket.connected() {
                state.shell.add_session(socket_id, session);
                let _ = socket.emit(
                    ServerEvent::ShellCreated.as_str(),
                    &ShellCreatedPayload {
                        status: "success".to_string(),
                        session_id,
                    },
                );
            } else {
                std::thread::spawn(move || drop(session));
            }
        }
        Err(e) => emit_error(&socket, ServerEvent::ShellError, "create shell", e),
    }
}

pub async fn handle_shell_input(socket: SocketRef, Data(data): Data<ShellInputEvent>, State(state): State<AppState>) {
    if let Err(e) = state.shell.write_to_shell(&socket.id.to_string(), &data.command) {
        tracing::error!("Shell write error: {}", e);
    }
}

pub async fn handle_shell_resize(socket: SocketRef, Data(data): Data<ShellResizeEvent>, State(state): State<AppState>) {
    if let Err(e) = state.shell.resize_shell(&socket.id.to_string(), data.cols, data.rows) {
        tracing::error!("Shell resize error: {}", e);
    }
}

pub async fn handle_shell_close(socket: SocketRef, State(state): State<AppState>) {
    state.shell.close_session(&socket.id.to_string());
}

pub async fn handle_list_shells(socket: SocketRef, State(state): State<AppState>) {
    let shell = state.shell.clone();
    let (shells, default) = run_or_log_default(move || shell.list_available_shells()).await;

    let _ = socket.emit(
        ServerEvent::AvailableShells.as_str(),
        &AvailableShellsPayload { shells, default },
    );
}

pub async fn handle_disconnect(socket: SocketRef, State(state): State<AppState>) {
    if socket.extensions.remove::<TaskPollMarker>().is_some() {
        state.task_watchers.fetch_sub(1, Ordering::Relaxed);
    }

    state.shell.close_session(&socket.id.to_string());

    let socket_id = socket.id.to_string();
    let was_screen_owner = state.screen.disconnect_if_owner(&socket_id);
    state.audio.disconnect_if_owner(&socket_id);
    state.camera.disconnect_if_owner(&socket_id);

    if was_screen_owner {
        let input = state.input.clone();
        tokio::spawn(async move {
            input.click_mouse(MouseButton::Left, false).await;
            input.click_mouse(MouseButton::Right, false).await;
            input.click_mouse(MouseButton::Middle, false).await;
        });
    }
}

pub async fn handle_task_poll_start(socket: SocketRef, State(state): State<AppState>) {
    if socket.extensions.insert(TaskPollMarker).is_none() {
        state.task_watchers.fetch_add(1, Ordering::Relaxed);
        socket.join("task_watchers");
    }
}

pub async fn handle_task_poll_stop(socket: SocketRef, State(state): State<AppState>) {
    if socket.extensions.remove::<TaskPollMarker>().is_some() {
        state.task_watchers.fetch_sub(1, Ordering::Relaxed);
        socket.leave("task_watchers");
    }
}

pub async fn handle_start_server_audio(
    socket: SocketRef,
    Data(data): Data<AudioConfig>,
    State(state): State<AppState>,
) {
    let audio = &state.audio;
    let source = data.source.unwrap_or(AudioSourceKind::Mic);
    let rate = data.rate.unwrap_or(48000);
    let device_id = data.device_id.filter(|id| !id.is_empty());

    if let Err(e) = audio.start_server_stream(socket.clone(), source, device_id, rate) {
        emit_error(&socket, ServerEvent::ServerAudioError, "start server audio", e);
    }
}

pub async fn handle_list_audio_sources(socket: SocketRef) {
    match run(AudioManager::list_sources).await {
        Ok(sources) => {
            let _ = socket.emit(ServerEvent::AudioSources.as_str(), &AudioSourcesPayload { sources });
        }
        Err(e) => emit_error(&socket, ServerEvent::AudioSourcesError, "list audio sources", e),
    }
}

pub async fn handle_stop_server_audio(socket: SocketRef, State(state): State<AppState>) {
    state.audio.stop_server_stream_if_owner(&socket.id.to_string());
}

pub async fn handle_start_client_audio(
    socket: SocketRef,
    Data(data): Data<AudioConfig>,
    State(state): State<AppState>,
) {
    let audio = &state.audio;
    let rate = data.rate.unwrap_or(48000);

    if let Err(e) = audio.start_client_playback(socket.id.to_string(), rate) {
        emit_error(&socket, ServerEvent::ClientAudioError, "start client playback", e);
    }
}

pub async fn handle_stop_client_audio(socket: SocketRef, State(state): State<AppState>) {
    state.audio.stop_client_playback_if_owner(&socket.id.to_string());
}

pub async fn handle_client_audio_data(
    socket: SocketRef,
    Data(data): Data<bytes::Bytes>,
    State(state): State<AppState>,
) {
    state.audio.process_client_audio(&socket.id.to_string(), data.to_vec());
}

pub async fn handle_start_stream(
    socket: SocketRef,
    Data(data): Data<StartStreamConfig>,
    State(state): State<AppState>,
) {
    let screen = state.screen.clone();
    if let Err(e) = screen
        .start_stream(socket.clone(), state, data.capture_cursor.unwrap_or(true))
        .await
    {
        emit_error(&socket, ServerEvent::WebrtcError, "start stream", e);
    }
}

pub async fn handle_list_cameras(socket: SocketRef) {
    let cameras = run_or_log_default(CameraManager::list_cameras).await;
    let _ = socket.emit(ServerEvent::CameraList.as_str(), &CameraListPayload { cameras });
}

pub async fn handle_start_camera_stream(
    socket: SocketRef,
    Data(data): Data<CameraStartConfig>,
    State(state): State<AppState>,
) {
    let camera = state.camera.clone();
    let stream_socket = socket.clone();
    let result = run(move || camera.start_stream(stream_socket, state, data.device_id)).await;

    if let Err(e) = result {
        emit_error(&socket, ServerEvent::CameraWebrtcError, "start camera stream", e);
    }
}

pub async fn handle_stop_camera_stream(State(state): State<AppState>) {
    state.camera.stop_stream();
}

#[derive(Deserialize, Debug)]
pub struct IceCandidateEvent {
    sdp_mline_index: Option<u32>,
    candidate: String,
}

macro_rules! webrtc_signal_handlers {
    ($answer_fn:ident, $ice_fn:ident, $manager:ident) => {
        pub async fn $answer_fn(Data(sdp): Data<String>, State(state): State<AppState>) {
            state.$manager.set_remote_description(sdp);
        }

        pub async fn $ice_fn(Data(ice): Data<IceCandidateEvent>, State(state): State<AppState>) {
            let Some(sdp_mline_index) = ice.sdp_mline_index else {
                return;
            };
            state.$manager.add_ice_candidate(sdp_mline_index, ice.candidate);
        }
    };
}

webrtc_signal_handlers!(handle_webrtc_answer, handle_webrtc_ice, screen);
webrtc_signal_handlers!(handle_camera_webrtc_answer, handle_camera_webrtc_ice, camera);
