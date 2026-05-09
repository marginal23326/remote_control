use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

use crossbeam_channel::{Receiver, Sender, TrySendError};

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

use super::{FrameRateLimiter, RawFrame, StreamSettings};

pub(crate) async fn start_os_capture(
    work_tx: Sender<RawFrame>,
    recycle_rx: Receiver<Vec<u8>>,
    settings: Arc<Mutex<StreamSettings>>,
    is_running: Arc<AtomicBool>,
    _native_size: Arc<Mutex<(i32, i32)>>,
) -> anyhow::Result<()> {
    thread::spawn(move || {
        let monitor = Monitor::primary().expect("No primary monitor found");
        let capture_ctx = CaptureContext::new(work_tx, recycle_rx, is_running.clone(), settings);

        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(std::time::Duration::ZERO),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            capture_ctx,
        );

        if let Err(e) = CaptureHandler::start(settings) {
            tracing::error!("Capture ended: {}", e);
        }

        is_running.store(false, Ordering::SeqCst);
    });

    Ok(())
}

pub(crate) fn get_os_native_size(_native_size: &Arc<Mutex<(i32, i32)>>) -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

struct CaptureContext {
    work_tx: Sender<RawFrame>,
    recycle_rx: Receiver<Vec<u8>>,
    is_running: Arc<AtomicBool>,
    settings: Arc<Mutex<StreamSettings>>,
    limiter: FrameRateLimiter,
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
            limiter: FrameRateLimiter::new(),
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

        if !self.ctx.limiter.should_process(target_fps) {
            return Ok(());
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

pub(crate) fn get_active_window_title() -> String {
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
