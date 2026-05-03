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

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("remote-control input is only implemented for Windows and Linux.");
