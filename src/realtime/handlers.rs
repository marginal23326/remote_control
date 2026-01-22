use serde::Deserialize;
use serde_json::json;
use socketioxide::extract::{Data, State, SocketRef};
use tokio::time::Duration;
use tokio::task::AbortHandle;
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

#[derive(Debug, Clone)]
struct TaskPollTask {
    handle: AbortHandle,
}

// --- HANDLERS ---

pub async fn handle_mouse_event(
    Data(data): Data<MouseEvent>,
    State(state): State<SharedState>,
) {
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
    let session_id = socket.id.to_string(); 

    if let Err(e) = shell_manager.create_session(session_id.clone(), data.cols, data.rows, socket.clone()) {
        tracing::error!("Failed to create shell: {}", e);
        let _ = socket.emit("shell_error", &json!({ "message": e.to_string() }));
        return;
    }

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
    // Abort the polling task if it exists
    if let Some(task) = socket.extensions.remove::<TaskPollTask>() {
        task.handle.abort();
    }

    let mut shell_manager = state.shell.lock().unwrap();
    shell_manager.close_session(&socket.id.to_string());
}

pub async fn handle_task_poll_start(
    socket: SocketRef,
    State(state): State<SharedState>,
) {
    // 1. Check if a task is already running for this socket and abort it to prevent duplicates
    if let Some(task) = socket.extensions.remove::<TaskPollTask>() {
        task.handle.abort();
    }

    let socket_clone = socket.clone();
    
    // 2. Spawn the task and get the JoinHandle
    let join_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        
        loop {
            interval.tick().await;

            let data = {
                let tasks = state.tasks.lock().unwrap();
                let processes = tasks.get_processes();
                
                let sys = state.sys.lock().unwrap();
                let total_mem = sys.total_memory() as f64;
                let used_mem = sys.used_memory() as f64;
                let mem_pct = if total_mem > 0.0 { (used_mem / total_mem) * 100.0 } else { 0.0 };
                
                let cpu_global = sys.global_cpu_usage();

                json!({
                    "processes": processes,
                    "total_cpu_usage": cpu_global,
                    "total_memory_percentage": mem_pct
                })
            };

            // If emit fails (socket closed), break the loop
            if socket_clone.emit("task_list", &data).is_err() {
                break; 
            }
        }
    });

    // 3. Store the AbortHandle in the socket extensions
    socket.extensions.insert(TaskPollTask { 
        handle: join_handle.abort_handle() 
    });
}

pub async fn handle_task_poll_stop(
    socket: SocketRef,
) {
    // Retrieve the handle from extensions and abort the task
    if let Some(task) = socket.extensions.remove::<TaskPollTask>() {
        task.handle.abort();
    }
}