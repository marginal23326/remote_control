use std::os::fd::OwnedFd;

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
