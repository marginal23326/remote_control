use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{Data, State, SocketRef};
use crate::state::SharedState;

// --- DATA STRUCTURES ---

#[derive(Deserialize, Debug)]
pub struct MouseEvent {
    pub r#type: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub button: Option<String>,
    pub pressed: Option<bool>,
    pub dx: Option<i32>,
    pub dy: Option<i32>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")] 
pub enum KeyboardEvent {
    Text { text: String },
    Shortcut { shortcut: String, modifiers: Option<Vec<String>> },
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

// --- HANDLERS ---

pub async fn handle_mouse_event(
    Data(data): Data<MouseEvent>,
    State(state): State<SharedState>,
) {
    // We have to lock the mutex inside the Arc
    let input = state.input.lock().unwrap();

    match data.r#type.as_str() {
        "move" => {
            if let (Some(x), Some(y)) = (data.x, data.y) {
                input.move_mouse(x as i32, y as i32);
            }
        }
        "click" => {
            if let (Some(btn), Some(pressed)) = (data.button, data.pressed) {
                input.click_mouse(&btn, pressed);
            }
        }
        "scroll" => {
            let dx = data.dx.unwrap_or(0);
            let dy = data.dy.unwrap_or(0);
            if dx != 0 || dy != 0 {
                input.scroll_mouse(dx, dy);
            }
        }
        _ => {}
    }
}

pub async fn handle_keyboard_event(
    Data(data): Data<KeyboardEvent>,
    State(state): State<SharedState>,
) {
    let input = state.input.lock().unwrap();
    
    match data {
        KeyboardEvent::Text { text } => {
            input.type_text(&text);
        },
        KeyboardEvent::Shortcut { shortcut, modifiers } => {
            let mods = modifiers.unwrap_or_default();
            input.send_shortcut(&shortcut, mods);
        }
    }
}

pub async fn handle_shell_create(
    socket: SocketRef,
    Data(data): Data<ShellCreateEvent>,
    State(state): State<SharedState>,
) {
    let mut shell_manager = state.shell.lock().unwrap();
    
    // Use socket ID as session ID
    let session_id = socket.id.to_string(); 

    if let Err(e) = shell_manager.create_session(session_id.clone(), data.cols, data.rows, socket.clone()) {
        tracing::error!("Failed to create shell: {}", e);
        let _ = socket.emit("shell_error", &json!({ "message": e.to_string() }));
        return;
    }

    // Tell frontend the ID
    let _ = socket.emit("shell_created", &json!({ 
        "status": "success",
        "session_id": session_id 
    }));
}

pub async fn handle_shell_input(
    Data(data): Data<ShellInputEvent>,
    State(state): State<SharedState>,
) {
    let mut shell_manager = state.shell.lock().unwrap();
    if let Err(e) = shell_manager.write_to_shell(&data.session_id, &data.command) {
        tracing::error!("Shell write error: {}", e);
    }
}

pub async fn handle_shell_resize(
    Data(data): Data<ShellResizeEvent>,
    State(state): State<SharedState>,
) {
    let mut shell_manager = state.shell.lock().unwrap();
    if let Err(e) = shell_manager.resize_shell(&data.session_id, data.cols, data.rows) {
        tracing::error!("Shell resize error: {}", e);
    }
}

pub async fn handle_disconnect(
    socket: SocketRef,
    State(state): State<SharedState>,
) {
    let mut shell_manager = state.shell.lock().unwrap();
    // Try to close session for this socket ID (if it exists)
    shell_manager.close_session(&socket.id.to_string());
}