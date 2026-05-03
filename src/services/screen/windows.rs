use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use tokio::sync::watch;

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

use super::encoder::run_encoder_loop;
use super::{RawFrame, StreamFrame, StreamSettings};

pub struct ScreenManager {
    pub settings: Arc<Mutex<StreamSettings>>,
    tx: watch::Sender<StreamFrame>,
    rx: watch::Receiver<StreamFrame>,
    is_running: Arc<AtomicBool>,
}

impl ScreenManager {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(StreamFrame::default());
        Self {
            settings: Arc::new(Mutex::new(StreamSettings::default())),
            tx,
            rx,
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn get_frame_receiver(&self) -> watch::Receiver<StreamFrame> {
        self.rx.clone()
    }

    pub fn update_settings(&self, quality: u8, resolution: u8) {
        let mut s = self.settings.lock().unwrap();
        s.quality = quality.clamp(10, 100);
        s.resolution_percentage = resolution.clamp(10, 100);
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

        let settings_arc = self.settings.clone();
        let tx_web = self.tx.clone();
        let is_running_clone = self.is_running.clone();

        thread::spawn(move || {
            let (work_tx, work_rx) = bounded::<RawFrame>(3);
            let (recycle_tx, recycle_rx) = bounded::<Vec<u8>>(5);

            let settings_enc = settings_arc.clone();
            let is_running_enc = is_running_clone.clone();

            thread::spawn(move || {
                run_encoder_loop(
                    work_rx,
                    recycle_tx,
                    tx_web,
                    settings_enc,
                    is_running_enc,
                    get_active_window_title,
                );
            });

            let monitor = Monitor::primary().expect("No primary monitor found");

            let capture_ctx =
                CaptureContext::new(work_tx, recycle_rx, is_running_clone.clone(), settings_arc);

            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(Duration::ZERO),
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                capture_ctx,
            );

            if let Err(e) = CaptureHandler::start(settings) {
                tracing::error!("Capture ended: {}", e);
            }

            is_running_clone.store(false, Ordering::SeqCst);
        });

        Ok(())
    }

    pub fn stop_capture(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }

    pub fn native_size(&self) -> (i32, i32) {
        unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
    }
}

struct CaptureContext {
    work_tx: Sender<RawFrame>,
    recycle_rx: Receiver<Vec<u8>>,
    is_running: Arc<AtomicBool>,
    settings: Arc<Mutex<StreamSettings>>,
    last_arrival: Instant,
    accumulated: Duration,
}

impl CaptureContext {
    fn new(
        work_tx: Sender<RawFrame>,
        recycle_rx: Receiver<Vec<u8>>,
        is_running: Arc<AtomicBool>,
        settings: Arc<Mutex<StreamSettings>>,
    ) -> Self {
        Self {
            work_tx,
            recycle_rx,
            is_running,
            settings,
            last_arrival: Instant::now(),
            accumulated: Duration::ZERO,
        }
    }
}

struct CaptureHandler {
    ctx: CaptureContext,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureContext;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { ctx: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if !self.ctx.is_running.load(Ordering::SeqCst) {
            capture_control.stop();
            return Ok(());
        }

        let target_fps = self.ctx.settings.lock().unwrap().target_fps;
        let now = Instant::now();

        if target_fps < 120 {
            let interval = Duration::from_secs_f64(1.0 / target_fps as f64);
            let elapsed = now.saturating_duration_since(self.ctx.last_arrival);
            self.ctx.last_arrival = now;
            self.ctx.accumulated += elapsed;

            if self.ctx.accumulated < interval {
                return Ok(());
            }
            self.ctx.accumulated -= interval;
        }

        let width = frame.width();
        let height = frame.height();
        if width == 0 || height == 0 {
            return Ok(());
        }

        let mut buffer = self.ctx.recycle_rx.try_recv().unwrap_or_default();

        let frame_buffer = frame.buffer()?;
        let _ = frame_buffer.as_nopadding_buffer(&mut buffer);

        let raw = RawFrame {
            buffer,
            width,
            height,
        };

        if let Err(TrySendError::Full(returned)) = self.ctx.work_tx.try_send(raw) {
            let _ = self.ctx.recycle_rx.try_recv().unwrap_or(returned.buffer);
        }

        Ok(())
    }
}

fn get_active_window_title() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}
