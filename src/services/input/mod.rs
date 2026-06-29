use serde::Deserialize;
use tokio::sync::mpsc;

#[cfg(target_os = "linux")]
pub(crate) mod keymap;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[derive(Clone, Deserialize, Debug)]
pub struct MouseEvent {
    pub r#type: String,
    pub seq: Option<u64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub button: Option<String>,
    pub pressed: Option<bool>,
    pub dx: Option<i32>,
    pub dy: Option<i32>,
}

pub enum InputCommand {
    MoveMouse(i32, i32),
    ClickMouse(String, bool),
    ScrollMouse(i32, i32),
    TypeText(String),
    SendShortcut(String, Vec<String>),
    SetKeyState(String, bool),
}

#[derive(Clone)]
pub struct InputManager {
    tx: mpsc::UnboundedSender<InputCommand>,
}

impl InputManager {
    pub fn new() -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            #[cfg(windows)]
            let os_input = windows::OsInputManager::new();
            #[cfg(target_os = "linux")]
            let os_input = linux::OsInputManager::new();

            while let Some(cmd) = rx.recv().await {
                let result = match cmd {
                    InputCommand::MoveMouse(x, y) => os_input.move_mouse(x, y).await,
                    InputCommand::ClickMouse(btn, pressed) => os_input.click_mouse(&btn, pressed).await,
                    InputCommand::ScrollMouse(dx, dy) => os_input.scroll_mouse(dx, dy).await,
                    InputCommand::TypeText(text) => os_input.type_text(&text).await,
                    InputCommand::SendShortcut(key, mods) => os_input.send_shortcut(&key, mods).await,
                    InputCommand::SetKeyState(key, pressed) => os_input.set_key_state(&key, pressed).await,
                };
                if let Err(e) = result {
                    tracing::error!("Input execution failed: {e:#}");
                }
            }
        });
        Self { tx }
    }

    pub async fn move_mouse(&self, x: i32, y: i32) {
        let _ = self.tx.send(InputCommand::MoveMouse(x, y));
    }

    pub async fn click_mouse(&self, button: &str, pressed: bool) {
        let _ = self.tx.send(InputCommand::ClickMouse(button.to_string(), pressed));
    }

    pub async fn scroll_mouse(&self, dx: i32, dy: i32) {
        let _ = self.tx.send(InputCommand::ScrollMouse(dx, dy));
    }

    pub async fn type_text(&self, text: &str) {
        let _ = self.tx.send(InputCommand::TypeText(text.to_string()));
    }

    pub async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) {
        let _ = self.tx.send(InputCommand::SendShortcut(key.to_string(), modifiers));
    }

    pub async fn set_key_state(&self, key: &str, pressed: bool) {
        let _ = self.tx.send(InputCommand::SetKeyState(key.to_string(), pressed));
    }
}

pub async fn apply_mouse_event(input: &InputManager, data: MouseEvent) {
    match data.r#type.as_str() {
        "move" => {
            if let (Some(x), Some(y)) = (data.x, data.y) {
                input.move_mouse(x as i32, y as i32).await;
            }
        }
        "click" => {
            if let (Some(x), Some(y)) = (data.x, data.y) {
                input.move_mouse(x as i32, y as i32).await;
            }
            if let (Some(btn), Some(pressed)) = (data.button, data.pressed) {
                input.click_mouse(&btn, pressed).await;
            }
        }
        "scroll" => {
            let dx = data.dx.unwrap_or(0);
            let dy = data.dy.unwrap_or(0);
            if dx != 0 || dy != 0 {
                input.scroll_mouse(dx, dy).await;
            }
        }
        _ => {}
    }
}
