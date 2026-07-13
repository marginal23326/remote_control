use bytes::Bytes;
use parking_lot::Mutex;
use std::sync::{
    Arc, OnceLock,
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
            (dev_mode.dmDisplayFrequency as u64).max(1)
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
    capture_cursor: bool,
) -> anyhow::Result<()> {
    unsafe {
        *native_size.lock() = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
    }

    let monitor = Monitor::primary().map_err(|e| anyhow::anyhow!("No primary monitor found: {}", e))?;

    thread::spawn(move || {
        let capture_ctx = CaptureContext::new(work_tx, recycle_rx, is_running.clone(), settings, native_size.clone());

        let cursor_capture_settings = if capture_cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };

        let settings = Settings::new(
            monitor,
            cursor_capture_settings,
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
            let s = self.ctx.settings.lock();
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
            *self.ctx.native_size.lock() = (width as i32, height as i32);
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

type CachedScreenshot = (Bytes, u32, u32);

static LAST_SCREENSHOT: OnceLock<Mutex<Option<CachedScreenshot>>> = OnceLock::new();

fn last_screenshot_cache() -> &'static Mutex<Option<CachedScreenshot>> {
    LAST_SCREENSHOT.get_or_init(|| Mutex::new(None))
}

fn try_capture_frame(
    dup: &mut windows_capture::dxgi_duplication_api::DxgiDuplicationApi,
) -> anyhow::Result<Option<CachedScreenshot>> {
    use windows_capture::dxgi_duplication_api::Error as DupError;
    use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};

    let mut frame = match dup.acquire_next_frame(1_000) {
        Ok(frame) => frame,
        Err(DupError::Timeout) => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    if frame.frame_info().LastPresentTime == 0 {
        frame = match dup.acquire_next_frame(1_000) {
            Ok(frame) => frame,
            Err(DupError::Timeout) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
    }

    let buf = frame.buffer()?;
    let (width, height) = (buf.width(), buf.height());

    let mut scratch = Vec::new();
    let packed = buf.as_nopadding_buffer(&mut scratch);

    let png_bytes: Bytes = ImageEncoder::new(ImageFormat::Png, ImageEncoderPixelFormat::Bgra8)?
        .encode(packed, width, height)?
        .into();

    Ok(Some((png_bytes, width, height)))
}

pub(crate) async fn take_screenshot() -> anyhow::Result<(Bytes, &'static str)> {
    tokio::task::spawn_blocking(|| {
        use windows_capture::dxgi_duplication_api::DxgiDuplicationApi;
        use windows_capture::monitor::Monitor;

        let monitor = Monitor::primary()?;
        let mut dup = match DxgiDuplicationApi::new(monitor) {
            Ok(d) => d,
            Err(windows_capture::dxgi_duplication_api::Error::WindowsError(e))
                if e.code().0 == 0x887A0004u32 as i32 =>
            {
                anyhow::bail!(
                    "Desktop Duplication API is not supported on this GPU.\n\n\
                     Search 'Graphics settings' in the Start menu, find this app, \
                     and set GPU preference to 'Power saving'."
                );
            }
            Err(e) => return Err(e.into()),
        };

        match try_capture_frame(&mut dup)? {
            Some((png_bytes, width, height)) => {
                *last_screenshot_cache().lock() = Some((png_bytes.clone(), width, height));
                Ok((png_bytes, "image/png"))
            }
            None => {
                let (dup_width, dup_height) = (dup.width(), dup.height());
                let cached = last_screenshot_cache()
                    .lock()
                    .clone()
                    .filter(|(_, w, h)| *w == dup_width && *h == dup_height);

                match cached {
                    Some((png_bytes, _, _)) => {
                        tracing::debug!("Screen appears static; serving the last captured screenshot");
                        Ok((png_bytes, "image/png"))
                    }
                    None => anyhow::bail!(
                        "Timed out waiting for a screen update; try again after interacting with the screen."
                    ),
                }
            }
        }
    })
    .await?
}
