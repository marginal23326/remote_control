use anyhow::Result;
use ashpd::desktop::remote_desktop::KeyState;
use xkeysym::Keysym;

use super::keymap::LogicalKey;
use crate::services::screen::linux::portal_session;

#[derive(Clone)]
pub(crate) struct OsInputManager;

impl OsInputManager {
    pub fn new() -> Self {
        Self
    }
}

fn shortcut_keysym(name: &str) -> Option<u32> {
    Some(LogicalKey::parse(name)?.to_keysym())
}

impl super::OsInput for OsInputManager {
    async fn move_mouse(&self, x: i32, y: i32) -> Result<()> {
        portal_session()
            .notify_pointer_motion_absolute(x as f64, y as f64)
            .await
    }

    async fn click_mouse(&self, button: super::MouseButton, pressed: bool) -> Result<()> {
        let code = match button {
            super::MouseButton::Left => 0x110,
            super::MouseButton::Right => 0x111,
            super::MouseButton::Middle => 0x112,
        };

        let state = if pressed { KeyState::Pressed } else { KeyState::Released };

        portal_session().notify_pointer_button(code, state).await
    }

    async fn scroll_mouse(&self, dx: i32, dy: i32) -> Result<()> {
        portal_session().notify_pointer_axis(dx, dy).await
    }

    async fn type_text(&self, text: &str) -> Result<()> {
        let session = portal_session();
        for ch in text.chars() {
            let keysym = Keysym::from_char(ch).raw() as i32;
            session.notify_keyboard_keysym(keysym, KeyState::Pressed).await?;
            session.notify_keyboard_keysym(keysym, KeyState::Released).await?;
        }

        Ok(())
    }

    async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) -> Result<()> {
        let session = portal_session();
        let mut pressed_modifiers = Vec::new();

        let mut result = async {
            for modifier in modifiers {
                if let Some(keysym) = shortcut_keysym(&modifier) {
                    session.notify_keyboard_keysym(keysym as i32, KeyState::Pressed).await?;
                    pressed_modifiers.push(keysym);
                }
            }
            if let Some(keysym) = shortcut_keysym(key) {
                session.notify_keyboard_keysym(keysym as i32, KeyState::Pressed).await?;
                session
                    .notify_keyboard_keysym(keysym as i32, KeyState::Released)
                    .await?;
            }
            Ok(())
        }
        .await;

        for keysym in pressed_modifiers.into_iter().rev() {
            if let Err(e) = session.notify_keyboard_keysym(keysym as i32, KeyState::Released).await
                && result.is_ok()
            {
                result = Err(e);
            }
        }

        result
    }

    async fn set_key_state(&self, key: &str, pressed: bool) -> Result<()> {
        if let Some(keysym) = shortcut_keysym(key) {
            let state = if pressed { KeyState::Pressed } else { KeyState::Released };
            portal_session().notify_keyboard_keysym(keysym as i32, state).await?;
        }
        Ok(())
    }
}
