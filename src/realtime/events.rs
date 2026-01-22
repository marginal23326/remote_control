use socketioxide::{extract::{SocketRef, State}, SocketIo};
use serde_json::json;
use tracing::{info, warn};
use crate::state::SharedState;
use crate::utils::auth::{extract_token_from_cookie, verify_jwt};
use crate::realtime::handlers::{
    handle_mouse_event, 
    handle_keyboard_event,
    handle_shell_create,
    handle_shell_input,
    handle_shell_resize,
    handle_task_poll_start,
    handle_task_poll_stop,
    handle_disconnect
};

pub fn register(io: SocketIo) {
    io.ns("/", on_connect);
}

fn on_connect(socket: SocketRef, State(state): State<SharedState>) {
    // 1. Validate Authentication
    let headers = &socket.req_parts().headers;
    let cookie_str = headers.get("cookie")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    let is_authenticated = if let Some(token) = extract_token_from_cookie(cookie_str) {
        let config = state.config.lock().unwrap();
        verify_jwt(token, &config.jwt_secret)
    } else {
        false
    };

    if !is_authenticated {
        warn!("Socket connection rejected: Invalid or missing token");
        let _ = socket.emit("auth_error", &json!({ "message": "Unauthorized" }));
        socket.disconnect();
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

    // Cleanup
    socket.on_disconnect(handle_disconnect);
}