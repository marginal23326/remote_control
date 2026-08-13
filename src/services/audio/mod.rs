use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use ts_rs::TS;

use crate::services::owned_worker::{OwnedSession, StartGuard, Stoppable};
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

pub(crate) fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / i16::MAX as f32
}

pub(crate) fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
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
        self.running.store(false, Ordering::Relaxed);
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

    fn finish_thread_session(
        session: &OwnedSession<ThreadWorker>,
        guard: StartGuard<'_>,
        run: impl FnOnce(Arc<AtomicBool>) + Send + 'static,
    ) -> anyhow::Result<()> {
        let worker = ThreadWorker::spawn(run);
        session.finish_or_abort(guard, worker, ThreadWorker::stop, || {
            anyhow::anyhow!("Client disconnected during audio startup")
        })
    }

    pub fn start_server_stream(
        &self,
        socket: SocketRef,
        source: AudioSourceKind,
        device_id: Option<String>,
        rate: u32,
    ) -> anyhow::Result<()> {
        let guard = self
            .server
            .ownership()
            .try_start(socket.id.to_string())
            .map_err(|_| anyhow::anyhow!("Server audio is already active on another client"))?;

        Self::finish_thread_session(&self.server, guard, move |is_running| {
            if let Err(e) = backend::server_loop(socket, source, device_id, rate, is_running) {
                tracing::error!("Server audio capture error: {e:#}");
            }
        })
    }

    pub fn list_sources() -> anyhow::Result<Vec<AudioSourceInfo>> {
        backend::list_sources()
    }

    pub fn stop_server_stream_if_owner(&self, owner_id: &str) {
        self.server.stop_if_owner(owner_id);
    }

    pub fn start_client_playback(&self, owner_id: String, rate: u32) -> anyhow::Result<()> {
        let guard = self
            .client
            .ownership()
            .try_start(owner_id)
            .map_err(|_| anyhow::anyhow!("Client audio is already active on another client"))?;

        self.drain_client_buffer();

        let queue = self.client_audio_buffer.clone();
        Self::finish_thread_session(&self.client, guard, move |is_running| {
            if let Err(e) = backend::client_loop(rate, is_running, queue) {
                tracing::error!("Client audio playback error: {e:#}");
            }
        })
    }

    pub fn process_client_audio(&self, owner_id: &str, data: Vec<u8>) {
        if !self.client.ownership().owns(owner_id) {
            return;
        }

        for chunk in data.chunks_exact(2) {
            let f32_sample = i16_to_f32(i16::from_le_bytes([chunk[0], chunk[1]]));
            if self.client_audio_buffer.push(f32_sample).is_err() {
                let _ = self.client_audio_buffer.pop();
                let _ = self.client_audio_buffer.push(f32_sample);
            }
        }
    }

    pub fn stop_client_playback_if_owner(&self, owner_id: &str) {
        if self.client.stop_if_owner(owner_id) {
            self.drain_client_buffer();
        }
    }

    fn drain_client_buffer(&self) {
        while self.client_audio_buffer.pop().is_some() {}
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) {
        self.stop_server_stream_if_owner(owner_id);
        self.stop_client_playback_if_owner(owner_id);
    }
}
