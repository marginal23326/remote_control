#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{SystemInfoDTO, get_system_info};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{SystemInfoDTO, get_system_info};

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("remote-control system info is only implemented for Windows and Linux.");
