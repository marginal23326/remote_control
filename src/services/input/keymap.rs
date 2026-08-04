#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6,
    VK_F7, VK_F8, VK_F9, VK_F10, VK_F11, VK_F12, VK_HOME, VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR,
    VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SNAPSHOT, VK_SPACE, VK_TAB, VK_UP,
};
#[cfg(target_os = "linux")]
use xkeysym::key;

macro_rules! logical_keys {
    ($($variant:ident [$($alias:literal),+] => $keysym:expr, $vk:expr;)*) => {
        #[derive(Clone, Copy)]
        pub(crate) enum LogicalKey {
            $($variant,)*
            Char(char),
        }

        impl LogicalKey {
            pub(crate) fn parse(name: &str) -> Option<Self> {
                Some(match name.to_lowercase().as_str() {
                    $($($alias)|+ => Self::$variant,)*
                    s if s.chars().count() == 1 => Self::Char(s.chars().next()?),
                    _ => return None,
                })
            }

            #[cfg(target_os = "linux")]
            pub(crate) fn to_keysym(self) -> u32 {
                match self {
                    $(Self::$variant => $keysym,)*
                    Self::Char(ch) => xkeysym::Keysym::from_char(ch).raw(),
                }
            }

            #[cfg(windows)]
            pub(crate) fn to_vk(self) -> VIRTUAL_KEY {
                match self {
                    $(Self::$variant => $vk,)*
                    Self::Char(ch) if ch.is_ascii() => VIRTUAL_KEY(ch.to_ascii_uppercase() as u16),
                    Self::Char(_) => VIRTUAL_KEY(0),
                }
            }
        }
    };
}

logical_keys! {
    Shift     ["shift"]                => key::Shift_L,   VK_SHIFT;
    Control   ["ctrl", "control"]      => key::Control_L, VK_CONTROL;
    Alt       ["alt"]                  => key::Alt_L,     VK_MENU;
    Super     ["win", "super", "meta"] => key::Super_L,   VK_LWIN;
    Return    ["enter", "return"]      => key::Return,    VK_RETURN;
    BackSpace ["backspace"]            => key::BackSpace, VK_BACK;
    Tab       ["tab"]                  => key::Tab,       VK_TAB;
    Escape    ["esc", "escape"]        => key::Escape,    VK_ESCAPE;
    Space     ["space"]                => key::space,     VK_SPACE;
    Up        ["up"]                   => key::Up,        VK_UP;
    Down      ["down"]                 => key::Down,      VK_DOWN;
    Left      ["left"]                 => key::Left,      VK_LEFT;
    Right     ["right"]                => key::Right,     VK_RIGHT;
    Home      ["home"]                 => key::Home,      VK_HOME;
    End       ["end"]                  => key::End,       VK_END;
    PageUp    ["pageup"]               => key::Page_Up,   VK_PRIOR;
    PageDown  ["pagedown"]             => key::Page_Down, VK_NEXT;
    Insert    ["insert"]               => key::Insert,    VK_INSERT;
    Delete    ["delete"]               => key::Delete,    VK_DELETE;
    Print     ["printscreen"]          => key::Print,     VK_SNAPSHOT;
    F1  ["f1"]  => key::F1,  VK_F1;
    F2  ["f2"]  => key::F2,  VK_F2;
    F3  ["f3"]  => key::F3,  VK_F3;
    F4  ["f4"]  => key::F4,  VK_F4;
    F5  ["f5"]  => key::F5,  VK_F5;
    F6  ["f6"]  => key::F6,  VK_F6;
    F7  ["f7"]  => key::F7,  VK_F7;
    F8  ["f8"]  => key::F8,  VK_F8;
    F9  ["f9"]  => key::F9,  VK_F9;
    F10 ["f10"] => key::F10, VK_F10;
    F11 ["f11"] => key::F11, VK_F11;
    F12 ["f12"] => key::F12, VK_F12;
}
