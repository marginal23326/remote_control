use serde::Serialize;
use std::sync::Arc;
use std::thread;

use crate::services::owned_worker::OwnedWorker;
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

#[derive(Debug, Clone, Serialize)]
pub struct AudioSourceInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
}

pub struct AudioManager {
    server: OwnedWorker,
    client: OwnedWorker,
    client_audio_buffer: Arc<ArrayQueue<f32>>,
}

impl AudioManager {
    pub fn new() -> Self {
        #[cfg(windows)]
        let _ = wasapi::initialize_mta();

        #[cfg(target_os = "linux")]
        pipewire::init();

        Self {
            server: OwnedWorker::new(),
            client: OwnedWorker::new(),
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
        self.server.start(socket.id.to_string(), |is_running| {
            thread::spawn(move || {
                if let Err(e) = backend::server_loop(socket, source, device_id, rate, is_running) {
                    tracing::error!("Server audio capture error: {}", e);
                }
            })
        });
        Ok(())
    }

    pub fn list_sources(&self) -> Result<Vec<AudioSourceInfo>, String> {
        backend::list_sources()
    }

    pub fn stop_server_stream_if_owner(&self, owner_id: &str) {
        self.server.stop_if_owner(owner_id);
    }

    pub fn start_client_playback(&self, owner_id: String, rate: u32) -> Result<(), String> {
        self.stop_client_playback();

        let queue = self.client_audio_buffer.clone();
        self.client.start(owner_id, |is_running| {
            thread::spawn(move || {
                if let Err(e) = backend::client_loop(rate, is_running, queue) {
                    tracing::error!("Client audio playback error: {}", e);
                }
            })
        });
        Ok(())
    }

    pub fn process_client_audio(&self, data: Vec<u8>) {
        for chunk in data.chunks_exact(2) {
            let i16_sample = i16::from_le_bytes([chunk[0], chunk[1]]);
            let f32_sample = i16_sample as f32 / i16::MAX as f32;
            if self.client_audio_buffer.push(f32_sample).is_err() {
                let _ = self.client_audio_buffer.pop();
                let _ = self.client_audio_buffer.push(f32_sample);
            }
        }
    }

    pub fn stop_client_playback(&self) {
        self.client.stop();
        while self.client_audio_buffer.pop().is_some() {}
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
