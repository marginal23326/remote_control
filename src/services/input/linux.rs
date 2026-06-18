use anyhow::Result;
use ashpd::desktop::remote_desktop::KeyState;
use xkeysym::Keysym;

use super::keymap::shortcut_keysym;
use crate::services::screen::linux::portal_session;

pub struct InputManager;

impl InputManager {
    pub fn new() -> Self {
        Self
    }

    pub async fn move_mouse(&self, x: i32, y: i32) -> Result<()> {
        portal_session()
            .notify_pointer_motion_absolute(x as f64, y as f64)
            .await
    }

    pub async fn click_mouse(&self, button: &str, pressed: bool) -> Result<()> {
        let code = match button {
            "left" => 0x110,
            "right" => 0x111,
            "middle" => 0x112,
            _ => return Ok(()),
        };

        let state = if pressed {
            KeyState::Pressed
        } else {
            KeyState::Released
        };

        portal_session().notify_pointer_button(code, state).await
    }

    pub async fn scroll_mouse(&self, dx: i32, dy: i32) -> Result<()> {
        portal_session().notify_pointer_axis(dx, dy).await
    }

    pub async fn type_text(&self, text: &str) -> Result<()> {
        for ch in text.chars() {
            let keysym = Keysym::from_char(ch).raw() as i32;
            portal_session()
                .notify_keyboard_keysym(keysym, KeyState::Pressed)
                .await?;
            portal_session()
                .notify_keyboard_keysym(keysym, KeyState::Released)
                .await?;
        }

        Ok(())
    }

    pub async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) -> Result<()> {
        let mut pressed_modifiers = Vec::new();
        let mut result: Result<()> = Ok(());

        for modifier in modifiers {
            if let Some(keysym) = shortcut_keysym(&modifier) {
                match portal_session()
                    .notify_keyboard_keysym(keysym as i32, KeyState::Pressed)
                    .await
                {
                    Ok(_) => pressed_modifiers.push(keysym),
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                }
            }
        }

        if result.is_ok() {
            if let Some(keysym) = shortcut_keysym(key) {
                if let Err(e) = portal_session()
                    .notify_keyboard_keysym(keysym as i32, KeyState::Pressed)
                    .await
                {
                    result = Err(e);
                } else if let Err(e) = portal_session()
                    .notify_keyboard_keysym(keysym as i32, KeyState::Released)
                    .await
                {
                    result = Err(e);
                }
            }
        }

        for keysym in pressed_modifiers.into_iter().rev() {
            if let Err(e) = portal_session()
                .notify_keyboard_keysym(keysym as i32, KeyState::Released)
                .await
            {
                if result.is_ok() {
                    result = Err(e);
                }
            }
        }

        result
    }
}
