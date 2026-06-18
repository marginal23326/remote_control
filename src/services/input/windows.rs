use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    SendInput, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1,
    VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_F10, VK_F11, VK_F12, VK_HOME,
    VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT,
    VK_SNAPSHOT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

pub struct InputManager {
    screen_width: i32,
    screen_height: i32,
}

impl InputManager {
    pub fn new() -> Self {
        let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        Self {
            screen_width: width,
            screen_height: height,
        }
    }

    // --- MOUSE FUNCTIONS ---

    fn send_mouse_input(&self, flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    pub async fn move_mouse(&self, x: i32, y: i32) -> anyhow::Result<()> {
        let abs_x = ((x as f64 * 65536.0) / self.screen_width as f64) as i32 + 1;
        let abs_y = ((y as f64 * 65536.0) / self.screen_height as f64) as i32 + 1;
        self.send_mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, abs_x, abs_y, 0);
        Ok(())
    }

    pub async fn click_mouse(&self, button: &str, pressed: bool) -> anyhow::Result<()> {
        let flags = match (button, pressed) {
            ("left", true) => MOUSEEVENTF_LEFTDOWN,
            ("left", false) => MOUSEEVENTF_LEFTUP,
            ("right", true) => MOUSEEVENTF_RIGHTDOWN,
            ("right", false) => MOUSEEVENTF_RIGHTUP,
            ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
            ("middle", false) => MOUSEEVENTF_MIDDLEUP,
            _ => return Ok(()),
        };
        // Mouse data is 0 for clicks
        self.send_mouse_input(flags, 0, 0, 0);
        Ok(())
    }

    pub async fn scroll_mouse(&self, dx: i32, dy: i32) -> anyhow::Result<()> {
        // Vertical Scroll
        if dy != 0 {
            self.send_mouse_input(MOUSEEVENTF_WHEEL, 0, 0, (dy * 120) as u32);
        }
        // Horizontal Scroll
        if dx != 0 {
            self.send_mouse_input(MOUSEEVENTF_HWHEEL, 0, 0, (dx * 120) as u32);
        }
        Ok(())
    }

    // --- KEYBOARD FUNCTIONS ---

    pub async fn type_text(&self, text: &str) -> anyhow::Result<()> {
        for ch in text.chars() {
            let mut buf = [0; 2];
            let encoded = ch.encode_utf16(&mut buf);
            for code_unit in encoded.iter() {
                self.send_key_event(VIRTUAL_KEY(0), Some(*code_unit), false);
                self.send_key_event(VIRTUAL_KEY(0), Some(*code_unit), true);
            }
        }
        Ok(())
    }

    pub async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) -> anyhow::Result<()> {
        let mut mod_vks = Vec::new();
        for modifier in modifiers {
            let vk = self.map_key_to_vk(&modifier);
            if vk.0 != 0 {
                self.send_key_event(vk, None, false);
                mod_vks.push(vk);
            }
        }

        if !key.is_empty() {
            let vk = self.map_key_to_vk(key);
            if vk.0 != 0 {
                self.send_key_event(vk, None, false);
                self.send_key_event(vk, None, true);
            }
        }

        for vk in mod_vks.into_iter().rev() {
            self.send_key_event(vk, None, true);
        }
        Ok(())
    }

    fn send_key_event(&self, vk: VIRTUAL_KEY, scan_code: Option<u16>, key_up: bool) {
        let mut flags = if key_up {
            KEYEVENTF_KEYUP
        } else {
            KEYBD_EVENT_FLAGS(0)
        };

        let w_scan = if let Some(sc) = scan_code {
            flags |= KEYEVENTF_UNICODE;
            sc
        } else {
            0
        };

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: w_scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    fn map_key_to_vk(&self, key: &str) -> VIRTUAL_KEY {
        match key.to_lowercase().as_str() {
            "shift" => VK_SHIFT,
            "ctrl" | "control" => VK_CONTROL,
            "alt" => VK_MENU,
            "win" | "super" | "meta" => VK_LWIN,
            "enter" | "return" => VK_RETURN,
            "backspace" => VK_BACK,
            "tab" => VK_TAB,
            "esc" | "escape" => VK_ESCAPE,
            "space" => VK_SPACE,
            "up" => VK_UP,
            "down" => VK_DOWN,
            "left" => VK_LEFT,
            "right" => VK_RIGHT,
            "home" => VK_HOME,
            "end" => VK_END,
            "pageup" => VK_PRIOR,
            "pagedown" => VK_NEXT,
            "insert" => VK_INSERT,
            "delete" => VK_DELETE,
            "printscreen" => VK_SNAPSHOT,
            "f1" => VK_F1,
            "f2" => VK_F2,
            "f3" => VK_F3,
            "f4" => VK_F4,
            "f5" => VK_F5,
            "f6" => VK_F6,
            "f7" => VK_F7,
            "f8" => VK_F8,
            "f9" => VK_F9,
            "f10" => VK_F10,
            "f11" => VK_F11,
            "f12" => VK_F12,
            s if s.len() == 1 => {
                let char_code = s.chars().next().unwrap().to_ascii_uppercase();
                VIRTUAL_KEY(char_code as u16)
            }
            _ => VIRTUAL_KEY(0),
        }
    }
}
