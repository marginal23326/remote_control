use anyhow::Result;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde_json::json;
use socketioxide::extract::SocketRef;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread;

pub struct ShellSession {
    pub master: Box<dyn MasterPty + Send>,
    pub input_tx: std::sync::mpsc::Sender<String>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
}

pub struct ShellManager {
    // Map of SessionID -> Active Shell Data
    sessions: HashMap<String, ShellSession>,
    pty_system: Box<dyn PtySystem + Send>,
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            // Load the native PTY backend (ConPTY on Windows)
            pty_system: Box::new(NativePtySystem::default()),
        }
    }

    pub fn create_session(&mut self, session_id: String, cols: u16, rows: u16, socket: SocketRef) -> Result<()> {
        // 1. Configure the PTY
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = self.pty_system.openpty(size)?;

        let cmd = CommandBuilder::new(default_shell());
        let mut child = pair.slave.spawn_command(cmd)?;
        let killer = child.clone_killer();

        // 3. Clone the reader to move into a background thread
        let mut reader = pair.master.try_clone_reader()?;
        let socket_clone = socket.clone();
        let sid = session_id.clone();

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

                                leftover = leftover[valid..].to_vec();
                                continue;
                            }

                            if let Some(err_len) = e.error_len() {
                                let _ = socket_clone
                                    .emit("shell_output", &json!({ "session_id": sid, "output": "\u{FFFD}" }));
                                leftover = leftover[err_len..].to_vec();
                                continue;
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
        });

        let sid_wait = session_id.clone();
        let socket_wait = socket.clone();
        thread::spawn(move || {
            let _ = child.wait();
            let _ = socket_wait.emit(
                "shell_output",
                &json!({ "session_id": sid_wait, "output": "\r\n\x1b[33m[Process Terminated]\x1b[0m\r\n" }),
            );
        });

        // 5. Set up input channel and dedicated background writer thread
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

        self.sessions.insert(
            session_id,
            ShellSession {
                master: pair.master,
                input_tx,
                killer,
            },
        );

        Ok(())
    }

    pub fn write_to_shell(&mut self, session_id: &str, data: &str) -> Result<()> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            let _ = session.input_tx.send(data.to_string());
        }
        Ok(())
    }

    pub fn resize_shell(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        Ok(())
    }

    // Clean up session
    pub fn close_session(&mut self, session_id: &str) {
        if let Some(mut session) = self.sessions.remove(session_id) {
            let _ = session.killer.kill();
            tracing::info!("Shell session closed/cleaned up: {}", session_id);
        }
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
