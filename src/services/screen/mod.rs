use std::sync::Arc;

#[derive(Clone, Default, Debug)]
pub struct StreamFrame {
    pub jpeg: Arc<Vec<u8>>,
    pub active_window: String,
    pub actual_fps: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct StreamSettings {
    pub quality: u8,
    pub resolution_percentage: u8,
    pub target_fps: u64,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            quality: 80,
            resolution_percentage: 100,
            target_fps: 60,
        }
    }
}

pub(crate) struct RawFrame {
    pub buffer: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub(crate) mod encoder;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::ScreenManager;

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "linux")]
pub use linux::ScreenManager;

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("remote-control screen capture is only implemented for Windows and Linux.");
