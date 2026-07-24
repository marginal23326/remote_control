use anyhow::Result;
use ashpd::desktop::remote_desktop::KeyState;
use xkeysym::{Keysym, key};

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
    Some(match LogicalKey::parse(name)? {
        LogicalKey::Shift => key::Shift_L,
        LogicalKey::Control => key::Control_L,
        LogicalKey::Alt => key::Alt_L,
        LogicalKey::Super => key::Super_L,
        LogicalKey::Return => key::Return,
        LogicalKey::BackSpace => key::BackSpace,
        LogicalKey::Tab => key::Tab,
        LogicalKey::Escape => key::Escape,
        LogicalKey::Space => key::space,
        LogicalKey::Up => key::Up,
        LogicalKey::Down => key::Down,
        LogicalKey::Left => key::Left,
        LogicalKey::Right => key::Right,
        LogicalKey::Home => key::Home,
        LogicalKey::End => key::End,
        LogicalKey::PageUp => key::Page_Up,
        LogicalKey::PageDown => key::Page_Down,
        LogicalKey::Insert => key::Insert,
        LogicalKey::Delete => key::Delete,
        LogicalKey::Print => key::Print,
        LogicalKey::F1 => key::F1,
        LogicalKey::F2 => key::F2,
        LogicalKey::F3 => key::F3,
        LogicalKey::F4 => key::F4,
        LogicalKey::F5 => key::F5,
        LogicalKey::F6 => key::F6,
        LogicalKey::F7 => key::F7,
        LogicalKey::F8 => key::F8,
        LogicalKey::F9 => key::F9,
        LogicalKey::F10 => key::F10,
        LogicalKey::F11 => key::F11,
        LogicalKey::F12 => key::F12,
        LogicalKey::Char(ch) => Keysym::from_char(ch).raw(),
    })
}

impl super::OsInput for OsInputManager {
    async fn move_mouse(&self, x: i32, y: i32) -> Result<()> {
        portal_session()
            .notify_pointer_motion_absolute(x as f64, y as f64)
            .await
    }

    async fn click_mouse(&self, button: &str, pressed: bool) -> Result<()> {
        let code = match button {
            "left" => 0x110,
            "right" => 0x111,
            "middle" => 0x112,
            _ => return Ok(()),
        };

        let state = if pressed { KeyState::Pressed } else { KeyState::Released };

        portal_session().notify_pointer_button(code, state).await
    }

    async fn scroll_mouse(&self, dx: i32, dy: i32) -> Result<()> {
        portal_session().notify_pointer_axis(dx, dy).await
    }

    async fn type_text(&self, text: &str) -> Result<()> {
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

    async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) -> Result<()> {
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

        if result.is_ok()
            && let Some(keysym) = shortcut_keysym(key)
        {
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

        for keysym in pressed_modifiers.into_iter().rev() {
            if let Err(e) = portal_session()
                .notify_keyboard_keysym(keysym as i32, KeyState::Released)
                .await
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
