use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};

use pipewire::{context::ContextRc, core::CoreRc, main_loop::MainLoopRc};

pub(crate) fn connect(fd: Option<OwnedFd>) -> anyhow::Result<(MainLoopRc, CoreRc)> {
    let mainloop = MainLoopRc::new(None)?;
    let context = ContextRc::new(&mainloop, None)?;
    let core = match fd {
        Some(fd) => context.connect_fd_rc(fd, None)?,
        None => context.connect_rc(None)?,
    };
    Ok((mainloop, core))
}

pub(crate) fn should_stop(is_running: &AtomicBool, main_loop: *mut pipewire::sys::pw_main_loop) -> bool {
    if is_running.load(Ordering::SeqCst) {
        return false;
    }
    unsafe {
        pipewire::sys::pw_main_loop_quit(main_loop);
    }
    true
}
