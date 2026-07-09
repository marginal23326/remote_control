use anyhow::Result;
use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde_json::json;
use socketioxide::extract::SocketRef;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

pub struct ShellSession {
    pub master: Box<dyn MasterPty + Send>,
    pub input_tx: std::sync::mpsc::Sender<String>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub active: Arc<AtomicBool>,
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}

#[derive(Clone)]
pub struct ShellManager {
    sessions: Arc<Mutex<HashMap<String, ShellSession>>>,
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        socket_id: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
        shell: Option<&str>,
        socket: SocketRef,
    ) -> Result<ShellSession> {
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = NativePtySystem::default().openpty(size)?;

        let cmd = CommandBuilder::new(resolve_shell(shell));
        let mut child = pair.slave.spawn_command(cmd)?;
        let killer = child.clone_killer();

        let mut reader = pair.master.try_clone_reader()?;
        let socket_clone = socket.clone();
        let sid = session_id.to_string();

        thread::spawn(move || {
            let mut buffer = [0u8; 1024];
            let mut leftover = Vec::new();

            loop {
                let n = match reader.read(&mut buffer) {
                    Ok(n) if n > 0 => n,
                    _ => break,
                };
                leftover.extend_from_slice(&buffer[..n]);

                while !leftover.is_empty() {
                    match std::str::from_utf8(&leftover) {
                        Ok(s) => {
                            let _ = socket_clone.emit("shell_output", &json!({ "session_id": sid, "output": s }));
                            leftover.clear();
                            break;
                        }
                        Err(e) => {
                            let valid = e.valid_up_to();

                            if valid > 0 {
                                let s = std::str::from_utf8(&leftover[..valid]).unwrap();
                                let _ = socket_clone.emit("shell_output", &json!({ "session_id": sid, "output": s }));

                                leftover.drain(..valid);
                                continue;
                            }

                            if let Some(err_len) = e.error_len() {
                                let _ = socket_clone
                                    .emit("shell_output", &json!({ "session_id": sid, "output": "\u{FFFD}" }));
                                leftover.drain(..err_len);
                                continue;
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
        });

        let sid_wait = session_id.to_string();
        let socket_id_wait = socket_id.to_string();
        let socket_wait = socket.clone();
        let sessions_for_wait = self.sessions.clone();
        let active = Arc::new(AtomicBool::new(true));
        let active_for_wait = active.clone();
        thread::spawn(move || {
            let _ = child.wait();
            let _ = socket_wait.emit(
                "shell_output",
                &json!({ "session_id": sid_wait, "output": "\r\n\x1b[33m[Process Terminated]\x1b[0m\r\n" }),
            );
            let _ = socket_wait.emit("shell_closed", &json!({ "session_id": sid_wait }));

            if active_for_wait.load(Ordering::Acquire) {
                let removed = sessions_for_wait.lock().remove(&socket_id_wait);
                if let Some(session) = removed {
                    thread::spawn(move || drop(session));
                }
            }
        });

        let mut writer = pair.master.take_writer()?;
        let (input_tx, input_rx) = std::sync::mpsc::channel::<String>();

        thread::spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if write!(writer, "{}", data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        Ok(ShellSession {
            master: pair.master,
            input_tx,
            killer,
            active,
        })
    }

    pub fn add_session(&self, session_id: String, session: ShellSession) {
        let replaced = self.sessions.lock().insert(session_id, session);
        if let Some(old_session) = replaced {
            old_session.active.store(false, Ordering::Release);
            std::thread::spawn(move || drop(old_session));
        }
    }

    pub fn write_to_shell(&self, session_id: &str, data: &str) -> Result<()> {
        if let Some(session) = self.sessions.lock().get_mut(session_id) {
            let _ = session.input_tx.send(data.to_string());
        }
        Ok(())
    }

    pub fn resize_shell(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(session) = self.sessions.lock().get_mut(session_id) {
            session.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        Ok(())
    }

    pub fn close_session(&self, session_id: &str) {
        let removed = self.sessions.lock().remove(session_id);
        if let Some(session) = removed {
            session.active.store(false, Ordering::Release);
            std::thread::spawn(move || {
                drop(session);
            });
        }
    }

    pub fn list_available_shells(&self) -> (Vec<String>, String) {
        let shells = detect_available_shells();
        let default = default_shell_id();

        let default = if shells.iter().any(|s| s.eq_ignore_ascii_case(&default)) {
            default
        } else {
            shells.first().cloned().unwrap_or(default)
        };

        (shells, default)
    }
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        "cmd.exe".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn default_shell_id() -> String {
    let default = default_shell();

    let name = std::path::Path::new(&default)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&default);

    if let Some(matched) = ALLOWED_SHELLS.iter().find(|s| s.eq_ignore_ascii_case(name)) {
        matched.to_string()
    } else {
        name.to_string()
    }
}

#[cfg(windows)]
const ALLOWED_SHELLS: &[&str] = &["cmd.exe", "pwsh.exe", "powershell.exe", "bash.exe"];

#[cfg(target_os = "linux")]
const ALLOWED_SHELLS: &[&str] = &["bash", "zsh", "fish", "sh", "dash", "ksh"];

fn resolve_shell(requested: Option<&str>) -> String {
    match requested.map(str::trim) {
        Some(name) if ALLOWED_SHELLS.iter().any(|s| s.eq_ignore_ascii_case(name)) => name.to_string(),
        _ => default_shell(),
    }
}

fn exists_in_path(name: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };

    std::env::split_paths(&path_var).any(|dir| {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return false;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            candidate
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }

        #[cfg(not(unix))]
        {
            true
        }
    })
}

pub fn detect_available_shells() -> Vec<String> {
    ALLOWED_SHELLS
        .iter()
        .filter(|name| exists_in_path(name))
        .map(|s| s.to_string())
        .collect()
}
