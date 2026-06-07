use crate::realtime::handlers::{
    handle_client_audio_data, handle_disconnect, handle_keyboard_event, handle_mouse_event,
    handle_shell_create, handle_shell_input, handle_shell_resize, handle_start_client_audio,
    handle_start_server_audio, handle_start_stream, handle_stop_client_audio,
    handle_stop_server_audio, handle_task_poll_start, handle_task_poll_stop, handle_webrtc_answer,
    handle_webrtc_ice,
};
use crate::state::SharedState;
use crate::utils::auth::{extract_token_from_cookie, verify_jwt};
use serde_json::json;
use socketioxide::{
    SocketIo,
    extract::{SocketRef, State},
};
use tracing::{info, warn};

pub fn register(io: SocketIo) {
    io.ns("/", on_connect);
}

async fn on_connect(socket: SocketRef, State(state): State<SharedState>) {
    let headers = &socket.req_parts().headers;
    let cookie_str = headers
        .get("cookie")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    let is_authenticated = if let Some(token) = extract_token_from_cookie(cookie_str) {
        let config = &state.config;
        verify_jwt(token, &config.jwt_secret)
    } else {
        false
    };

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

    socket.on("task_poll_start", handle_task_poll_start);
    socket.on("task_poll_stop", handle_task_poll_stop);

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
