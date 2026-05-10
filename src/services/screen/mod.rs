use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::bounded;
use tokio::sync::watch;

#[derive(Clone, Default, Debug)]
pub struct StreamFrame {
    pub jpeg: Arc<Vec<u8>>,
    pub active_window: String,
    pub actual_fps: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct StreamSettings {
    pub quality: u8,
    pub resolution_percentage: u8,
    pub target_fps: u64,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            quality: 80,
            resolution_percentage: 100,
            target_fps: 60,
        }
    }
}

pub(crate) struct RawFrame {
    pub buffer: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub(crate) struct FrameRateLimiter {
    last_arrival: Instant,
    accumulated: Duration,
}

impl FrameRateLimiter {
    pub(crate) fn new() -> Self {
        Self {
            last_arrival: Instant::now(),
            accumulated: Duration::ZERO,
        }
    }

    pub(crate) fn should_process(&mut self, target_fps: u64) -> bool {
        if target_fps >= 120 {
            return true;
        }
        let now = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / target_fps as f64);
        let elapsed = now.saturating_duration_since(self.last_arrival);
        self.last_arrival = now;
        self.accumulated += elapsed;

        if self.accumulated < interval {
            false
        } else {
            self.accumulated -= interval;
            true
        }
    }
}

pub struct ScreenManager {
    pub settings: Arc<Mutex<StreamSettings>>,
    tx: watch::Sender<StreamFrame>,
    rx: watch::Receiver<StreamFrame>,
    is_running: Arc<AtomicBool>,
    native_size: Arc<Mutex<(i32, i32)>>,
}

impl ScreenManager {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(StreamFrame::default());
        Self {
            settings: Arc::new(Mutex::new(StreamSettings::default())),
            tx,
            rx,
            is_running: Arc::new(AtomicBool::new(false)),
            native_size: Arc::new(Mutex::new((0, 0))),
        }
    }

    pub fn get_frame_receiver(&self) -> watch::Receiver<StreamFrame> {
        self.rx.clone()
    }

    pub fn update_settings(&self, quality: u8, resolution: u8) {
        let mut s = self.settings.lock().unwrap();
        s.quality = quality.clamp(1, 100);
        s.resolution_percentage = resolution.clamp(5, 100);
    }

    pub fn set_target_fps(&self, fps: u64) {
        let mut s = self.settings.lock().unwrap();
        s.target_fps = fps.clamp(1, 144);
    }

    pub async fn start_capture(&self) -> anyhow::Result<()> {
        if self.is_running.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.is_running.store(true, Ordering::SeqCst);

        let (work_tx, work_rx) = bounded::<RawFrame>(3);
        let (recycle_tx, recycle_rx) = bounded::<Vec<u8>>(5);

        if let Err(e) = start_os_capture(
            work_tx,
            recycle_rx,
            self.settings.clone(),
            self.is_running.clone(),
            self.native_size.clone(),
        )
        .await
        {
            self.is_running.store(false, Ordering::SeqCst);
            return Err(e);
        }

        let encoder_settings = self.settings.clone();
        let encoder_running = self.is_running.clone();
        let tx_web = self.tx.clone();

        thread::spawn(move || {
            encoder::run_encoder_loop(
                work_rx,
                recycle_tx,
                tx_web,
                encoder_settings,
                encoder_running,
                get_active_window_title,
            );
        });

        Ok(())
    }

    pub fn stop_capture(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }

    pub fn native_size(&self) -> (i32, i32) {
        get_os_native_size(&self.native_size)
    }
}

pub(crate) mod encoder;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::{get_active_window_title, get_os_native_size, start_os_capture};

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "linux")]
use linux::{get_active_window_title, get_os_native_size, start_os_capture};

#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("remote-control screen capture is only implemented for Windows and Linux.");
