use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

pub struct AudioManager {
    server_is_running: Arc<AtomicBool>,
    server_thread: Mutex<Option<thread::JoinHandle<()>>>,
    client_is_running: Arc<AtomicBool>,
    client_thread: Mutex<Option<thread::JoinHandle<()>>>,
    client_audio_buffer: Arc<ArrayQueue<f32>>,
}

impl AudioManager {
    pub fn new() -> Self {
        #[cfg(windows)]
        let _ = wasapi::initialize_mta();

        #[cfg(target_os = "linux")]
        pipewire::init();

        Self {
            server_is_running: Arc::new(AtomicBool::new(false)),
            server_thread: Mutex::new(None),
            client_is_running: Arc::new(AtomicBool::new(false)),
            client_thread: Mutex::new(None),
            client_audio_buffer: Arc::new(ArrayQueue::new(48000 * 2)),
        }
    }

    pub fn start_server_stream(&self, socket: SocketRef, source: String, rate: u32) -> Result<(), String> {
        self.stop_server_stream();

        self.server_is_running.store(true, Ordering::SeqCst);
        let is_running = self.server_is_running.clone();

        let handle = thread::spawn(move || {
            if let Err(e) = backend::server_loop(socket, source, rate, is_running) {
                tracing::error!("Server audio capture error: {}", e);
            }
        });

        *self.server_thread.lock().unwrap() = Some(handle);
        Ok(())
    }

    pub fn stop_server_stream(&self) {
        self.server_is_running.store(false, Ordering::SeqCst);

        if let Some(handle) = self.server_thread.lock().unwrap().take() {
            tokio::task::block_in_place(move || {
                let _ = handle.join();
            });
        }
    }

    pub fn start_client_playback(&self, rate: u32) -> Result<(), String> {
        self.stop_client_playback();

        self.client_is_running.store(true, Ordering::SeqCst);
        let is_running = self.client_is_running.clone();
        let queue = self.client_audio_buffer.clone();

        let handle = thread::spawn(move || {
            if let Err(e) = backend::client_loop(rate, is_running, queue) {
                tracing::error!("Client audio playback error: {}", e);
            }
        });

        *self.client_thread.lock().unwrap() = Some(handle);
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
        self.client_is_running.store(false, Ordering::SeqCst);

        if let Some(handle) = self.client_thread.lock().unwrap().take() {
            tokio::task::block_in_place(move || {
                let _ = handle.join();
            });
        }

        while self.client_audio_buffer.pop().is_some() {}
    }
}
