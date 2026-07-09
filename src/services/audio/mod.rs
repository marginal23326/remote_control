use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

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
    server_thread: Mutex<Option<(thread::JoinHandle<()>, Arc<AtomicBool>)>>,
    server_owner: Mutex<Option<String>>,

    client_thread: Mutex<Option<(thread::JoinHandle<()>, Arc<AtomicBool>)>>,
    client_owner: Mutex<Option<String>>,
    client_audio_buffer: Arc<ArrayQueue<f32>>,
}

impl AudioManager {
    pub fn new() -> Self {
        #[cfg(windows)]
        let _ = wasapi::initialize_mta();

        #[cfg(target_os = "linux")]
        pipewire::init();

        Self {
            server_thread: Mutex::new(None),
            server_owner: Mutex::new(None),
            client_thread: Mutex::new(None),
            client_owner: Mutex::new(None),
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
        self.stop_server_stream();

        *self.server_owner.lock() = Some(socket.id.to_string());
        let is_running = Arc::new(AtomicBool::new(true));

        let handle = {
            let is_running = is_running.clone();
            thread::spawn(move || {
                if let Err(e) = backend::server_loop(socket, source, device_id, rate, is_running) {
                    tracing::error!("Server audio capture error: {}", e);
                }
            })
        };

        *self.server_thread.lock() = Some((handle, is_running));
        Ok(())
    }

    pub fn list_sources(&self) -> Result<Vec<AudioSourceInfo>, String> {
        backend::list_sources()
    }

    pub fn stop_server_stream(&self) {
        *self.server_owner.lock() = None;

        if let Some((handle, is_running)) = self.server_thread.lock().take() {
            is_running.store(false, Ordering::SeqCst);
            tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            });
        }
    }

    pub fn stop_server_stream_if_owner(&self, owner_id: &str) {
        if self.server_owner.lock().as_deref() == Some(owner_id) {
            self.stop_server_stream();
        }
    }

    pub fn start_client_playback(&self, owner_id: String, rate: u32) -> Result<(), String> {
        self.stop_client_playback();

        *self.client_owner.lock() = Some(owner_id);
        let is_running = Arc::new(AtomicBool::new(true));
        let queue = self.client_audio_buffer.clone();

        let handle = {
            let is_running = is_running.clone();
            thread::spawn(move || {
                if let Err(e) = backend::client_loop(rate, is_running, queue) {
                    tracing::error!("Client audio playback error: {}", e);
                }
            })
        };

        *self.client_thread.lock() = Some((handle, is_running));
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
        *self.client_owner.lock() = None;

        if let Some((handle, is_running)) = self.client_thread.lock().take() {
            is_running.store(false, Ordering::SeqCst);
            tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            });
        }

        while self.client_audio_buffer.pop().is_some() {}
    }

    pub fn stop_client_playback_if_owner(&self, owner_id: &str) {
        if self.client_owner.lock().as_deref() == Some(owner_id) {
            self.stop_client_playback();
        }
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) {
        self.stop_server_stream_if_owner(owner_id);
        self.stop_client_playback_if_owner(owner_id);
    }
}
