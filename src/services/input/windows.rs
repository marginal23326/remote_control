use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MapVirtualKeyW, SendInput, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE,
    VK_F1, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_F10, VK_F11, VK_F12, VK_HOME, VK_INSERT, VK_LEFT,
    VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SNAPSHOT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

#[derive(Clone)]
pub struct InputManager;

impl InputManager {
    pub fn new() -> Self {
        Self
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
        let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };

        let width = if width > 0 { width } else { 1920 };
        let height = if height > 0 { height } else { 1080 };

        let abs_x = (((x - left) as f64 * 65536.0) / width as f64) as i32;
        let abs_y = (((y - top) as f64 * 65536.0) / height as f64) as i32;
        self.send_mouse_input(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            abs_x,
            abs_y,
            0,
        );
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
        let make_input = |code_unit, flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: code_unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        for ch in text.chars() {
            let mut buf = [0; 2];
            let encoded = ch.encode_utf16(&mut buf);
            let len = encoded.len();

            let mut inputs = [unsafe { std::mem::zeroed::<INPUT>() }; 4];

            for (i, &code_unit) in encoded.iter().enumerate() {
                inputs[i] = make_input(code_unit, KEYEVENTF_UNICODE);
                inputs[i + len] = make_input(code_unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            }

            unsafe { SendInput(&inputs[..len * 2], std::mem::size_of::<INPUT>() as i32) };
        }
        Ok(())
    }

    pub async fn send_shortcut(&self, key: &str, modifiers: Vec<String>) -> anyhow::Result<()> {
        let mut mod_vks = Vec::new();
        for modifier in modifiers {
            let vk = self.map_key_to_vk(&modifier);
            if vk.0 != 0 {
                self.send_key_event(vk, false);
                mod_vks.push(vk);
            }
        }

        if !key.is_empty() {
            let vk = self.map_key_to_vk(key);
            if vk.0 != 0 {
                self.send_key_event(vk, false);
                self.send_key_event(vk, true);
            }
        }

        for vk in mod_vks.into_iter().rev() {
            self.send_key_event(vk, true);
        }
        Ok(())
    }

    fn is_extended_key(vk: u16) -> bool {
        matches!(
            vk,
            0x21   // VK_PRIOR (Page Up)
            | 0x22 // VK_NEXT (Page Down)
            | 0x23 // VK_END
            | 0x24 // VK_HOME
            | 0x25 // VK_LEFT
            | 0x26 // VK_UP
            | 0x27 // VK_RIGHT
            | 0x28 // VK_DOWN
            | 0x2C // VK_SNAPSHOT (Print Screen)
            | 0x2D // VK_INSERT
            | 0x2E // VK_DELETE
            | 0x5B // VK_LWIN
            | 0x5C // VK_RWIN
            | 0x5D // VK_APPS
            | 0x6F // VK_DIVIDE
            | 0x90 // VK_NUMLOCK
        )
    }

    fn send_key_event(&self, vk: VIRTUAL_KEY, key_up: bool) {
        let mut flags = if key_up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };

        let sc = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
        let use_scan_code = sc != 0;

        if use_scan_code {
            flags |= KEYEVENTF_SCANCODE;
            if Self::is_extended_key(vk.0) {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
        }

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: if use_scan_code { VIRTUAL_KEY(0) } else { vk },
                    wScan: sc,
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
