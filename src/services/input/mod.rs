use serde::Deserialize;
use tokio::sync::mpsc;
use ts_rs::TS;

pub(crate) mod keymap;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

pub(crate) trait OsInput {
    async fn move_mouse(&self, x: i32, y: i32) -> anyhow::Result<()>;
    async fn click_mouse(&self, button: &str, pressed: bool) -> anyhow::Result<()>;
    async fn scroll_mouse(&self, dx: i32, dy: i32) -> anyhow::Result<()>;
    async fn type_text(&self, text: &str) -> anyhow::Result<()>;
    async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) -> anyhow::Result<()>;
    async fn set_key_state(&self, key: &str, pressed: bool) -> anyhow::Result<()>;
}

#[derive(Clone, Deserialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields)]
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

macro_rules! input_commands {
    ($($method:ident($($param:ident : $ty:ty),*) => $variant:ident => |$os:ident| $call:expr),+ $(,)?) => {
        pub enum InputCommand {
            $($variant($($ty),*)),+
        }

        impl InputManager {
            $(
                pub async fn $method(&self, $($param: $ty),*) {
                    let _ = self.tx.send(InputCommand::$variant($($param),*));
                }
            )+
        }

        async fn dispatch(os_input: &backend::OsInputManager, cmd: InputCommand) -> anyhow::Result<()> {
            match cmd {
                $(
                    InputCommand::$variant($($param),*) => {
                        let $os = os_input;
                        $call
                    },
                )+
            }
        }
    };
}

input_commands! {
    move_mouse(x: i32, y: i32) => MoveMouse => |os| os.move_mouse(x, y).await,
    click_mouse(button: String, pressed: bool) => ClickMouse => |os| os.click_mouse(&button, pressed).await,
    scroll_mouse(dx: i32, dy: i32) => ScrollMouse => |os| os.scroll_mouse(dx, dy).await,
    type_text(text: String) => TypeText => |os| os.type_text(&text).await,
    send_shortcut(key: String, modifiers: Vec<String>) => SendShortcut => |os| os.send_shortcut(&key, modifiers).await,
    set_key_state(key: String, pressed: bool) => SetKeyState => |os| os.set_key_state(&key, pressed).await,
}

#[derive(Clone)]
pub struct InputManager {
    tx: mpsc::UnboundedSender<InputCommand>,
}

impl InputManager {
    pub fn new() -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let os_input = backend::OsInputManager::new();

            while let Some(cmd) = rx.recv().await {
                if let Err(e) = dispatch(&os_input, cmd).await {
                    tracing::error!("Input execution failed: {e:#}");
                }
            }
        });
        Self { tx }
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
                input.click_mouse(btn, pressed).await;
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
