use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

use crossbeam_channel::{Receiver, Sender};

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
        SecondaryWindowSettings, Settings,
    },
};

use windows::Win32::Graphics::Gdi::{ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

use super::{FrameRateLimiter, RawFrame, StreamSettings};

pub(crate) fn get_max_fps() -> u64 {
    unsafe {
        let mut dev_mode: windows::Win32::Graphics::Gdi::DEVMODEW = std::mem::zeroed();
        dev_mode.dmSize = std::mem::size_of::<windows::Win32::Graphics::Gdi::DEVMODEW>() as u16;
        if EnumDisplaySettingsW(None, ENUM_CURRENT_SETTINGS, &mut dev_mode).as_bool() {
            dev_mode.dmDisplayFrequency as u64
        } else {
            60
        }
    }
}

pub(crate) async fn start_os_capture(
    work_tx: Sender<RawFrame>,
    recycle_rx: Receiver<Vec<u8>>,
    settings: Arc<Mutex<StreamSettings>>,
    is_running: Arc<AtomicBool>,
    native_size: Arc<Mutex<(i32, i32)>>,
) -> anyhow::Result<()> {
    unsafe {
        *native_size.lock().unwrap() = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    }

    thread::spawn(move || {
        let monitor = Monitor::primary().expect("No primary monitor found");
        let capture_ctx = CaptureContext::new(work_tx, recycle_rx, is_running.clone(), settings, native_size.clone());

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

pub(crate) fn get_display_native_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
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

struct CaptureContext {
    work_tx: Sender<RawFrame>,
    recycle_rx: Receiver<Vec<u8>>,
    is_running: Arc<AtomicBool>,
    settings: Arc<Mutex<StreamSettings>>,
    limiter: FrameRateLimiter,
    cached_buffer: Option<Vec<u8>>,
    native_size: Arc<Mutex<(i32, i32)>>,
    last_width: u32,
    last_height: u32,
}

impl CaptureContext {
    fn new(
        work_tx: Sender<RawFrame>,
        recycle_rx: Receiver<Vec<u8>>,
        is_running: Arc<AtomicBool>,
        settings: Arc<Mutex<StreamSettings>>,
        native_size: Arc<Mutex<(i32, i32)>>,
    ) -> Self {
        Self {
            work_tx,
            recycle_rx,
            is_running,
            settings,
            limiter: FrameRateLimiter::new(),
            cached_buffer: None,
            native_size,
            last_width: 0,
            last_height: 0,
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

        let (target_fps, max_fps) = {
            let s = self.ctx.settings.lock().unwrap();
            (s.target_fps, s.max_fps)
        };

        if !self.ctx.limiter.should_process(target_fps, max_fps) {
            return Ok(());
        }

        let width = frame.width();
        let height = frame.height();
        if width == 0 || height == 0 {
            return Ok(());
        }

        if width != self.ctx.last_width || height != self.ctx.last_height {
            self.ctx.last_width = width;
            self.ctx.last_height = height;
            *self.ctx.native_size.lock().unwrap() = (width as i32, height as i32);
        }

        let mut buffer = self
            .ctx
            .cached_buffer
            .take()
            .or_else(|| self.ctx.recycle_rx.try_recv().ok())
            .unwrap_or_default();

        let mut frame_buffer = match frame.buffer() {
            Ok(fb) => fb,
            Err(e) => {
                self.ctx.cached_buffer = Some(buffer);
                return Err(Box::new(e));
            }
        };

        let expected_size = (width * height * 4) as usize;

        if buffer.len() != expected_size {
            buffer.resize(expected_size, 0);
        }

        if !frame_buffer.has_padding() {
            buffer.copy_from_slice(frame_buffer.as_raw_buffer());
        } else {
            let _ = frame_buffer.as_nopadding_buffer(&mut buffer);
        }

        let raw = RawFrame { buffer, width, height };

        if let Err(err) = self.ctx.work_tx.try_send(raw) {
            self.ctx.cached_buffer = Some(err.into_inner().buffer);
        }

        Ok(())
    }
}
