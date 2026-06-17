use serde::Deserialize;

#[cfg(target_os = "linux")]
pub(crate) mod keymap;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::InputManager;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::InputManager;

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

pub async fn apply_mouse_event(input: &InputManager, data: MouseEvent) -> anyhow::Result<()> {
    match data.r#type.as_str() {
        "move" => {
            if let (Some(x), Some(y)) = (data.x, data.y) {
                input.move_mouse(x as i32, y as i32).await
            } else {
                Ok(())
            }
        }
        "click" => {
            if let (Some(x), Some(y)) = (data.x, data.y) {
                let _ = input.move_mouse(x as i32, y as i32).await;
            }
            if let (Some(btn), Some(pressed)) = (data.button, data.pressed) {
                input.click_mouse(&btn, pressed).await
            } else {
                Ok(())
            }
        }
        "scroll" => {
            let dx = data.dx.unwrap_or(0);
            let dy = data.dy.unwrap_or(0);
            if dx != 0 || dy != 0 {
                input.scroll_mouse(dx, dy).await
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

