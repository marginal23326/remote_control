use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use ts_rs::TS;

use crate::services::owned_worker::{OwnedSession, Stoppable};
use crossbeam_queue::ArrayQueue;
use socketioxide::extract::SocketRef;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(windows)]
use windows as backend;

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "bindings.ts")]
pub enum AudioSourceKind {
    Mic,
    System,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct AudioSourceInfo {
    pub id: String,
    pub name: String,
    pub kind: AudioSourceKind,
}

struct ThreadWorker {
    handle: thread::JoinHandle<()>,
    running: Arc<AtomicBool>,
}

impl ThreadWorker {
    fn spawn(f: impl FnOnce(Arc<AtomicBool>) + Send + 'static) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let handle = {
            let running = running.clone();
            thread::spawn(move || f(running))
        };
        Self { handle, running }
    }
}

impl Stoppable for ThreadWorker {
    fn stop(self) {
        self.running.store(false, Ordering::SeqCst);
        tokio::task::spawn_blocking(move || {
            let _ = self.handle.join();
        });
    }
}

pub struct AudioManager {
    server: OwnedSession<ThreadWorker>,
    client: OwnedSession<ThreadWorker>,
    client_audio_buffer: Arc<ArrayQueue<f32>>,
}

impl AudioManager {
    pub fn new() -> Self {
        #[cfg(windows)]
        let _ = wasapi::initialize_mta();

        #[cfg(target_os = "linux")]
        pipewire::init();

        Self {
            server: OwnedSession::new(),
            client: OwnedSession::new(),
            client_audio_buffer: Arc::new(ArrayQueue::new(48000 * 2)),
        }
    }

    pub fn start_server_stream(
        &self,
        socket: SocketRef,
        source: String,
        device_id: Option<String>,
        rate: u32,
    ) -> Result<(), String> {
        let guard = self
            .server
            .ownership()
            .try_start(socket.id.to_string())
            .map_err(|_| "Server audio is already active on another client".to_string())?;

        let worker = ThreadWorker::spawn(move |is_running| {
            if let Err(e) = backend::server_loop(socket, source, device_id, rate, is_running) {
                tracing::error!("Server audio capture error: {}", e);
            }
        });

        if let Err(worker) = self.server.finish_start(worker) {
            worker.stop();
            return Err("Client disconnected during audio startup".to_string());
        }
        guard.mark_started();
        Ok(())
    }

    pub fn list_sources(&self) -> Result<Vec<AudioSourceInfo>, String> {
        backend::list_sources()
    }

    pub fn stop_server_stream_if_owner(&self, owner_id: &str) {
        self.server.stop_if_owner(owner_id);
    }

    pub fn start_client_playback(&self, owner_id: String, rate: u32) -> Result<(), String> {
        let guard = self
            .client
            .ownership()
            .try_start(owner_id)
            .map_err(|_| "Client audio is already active on another client".to_string())?;

        while self.client_audio_buffer.pop().is_some() {}

        let queue = self.client_audio_buffer.clone();
        let worker = ThreadWorker::spawn(move |is_running| {
            if let Err(e) = backend::client_loop(rate, is_running, queue) {
                tracing::error!("Client audio playback error: {}", e);
            }
        });

        if let Err(worker) = self.client.finish_start(worker) {
            worker.stop();
            return Err("Client disconnected during audio startup".to_string());
        }
        guard.mark_started();
        Ok(())
    }

    pub fn process_client_audio(&self, owner_id: &str, data: Vec<u8>) {
        if !self.client.ownership().owns(owner_id) {
            return;
        }

        for chunk in data.chunks_exact(2) {
            let i16_sample = i16::from_le_bytes([chunk[0], chunk[1]]);
            let f32_sample = i16_sample as f32 / i16::MAX as f32;
            if self.client_audio_buffer.push(f32_sample).is_err() {
                let _ = self.client_audio_buffer.pop();
                let _ = self.client_audio_buffer.push(f32_sample);
            }
        }
    }

    pub fn stop_client_playback_if_owner(&self, owner_id: &str) {
        if self.client.stop_if_owner(owner_id) {
            while self.client_audio_buffer.pop().is_some() {}
        }
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) {
        self.stop_server_stream_if_owner(owner_id);
        self.stop_client_playback_if_owner(owner_id);
    }
}
