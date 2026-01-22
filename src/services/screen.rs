use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};
use std::collections::VecDeque;

use tokio::sync::watch;
use crossbeam_channel::{bounded, Sender, Receiver, TrySendError};

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
use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{Resizer, PixelType, ResizeOptions};

use turbojpeg::{Compressor, Image as JpegImage, PixelFormat, OutputBuf, Subsamp};

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

struct RawFrame {
    buffer: Vec<u8>,
    width: u32,
    height: u32,
}

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

    pub fn start_capture(&self) {
        if self.is_running.load(Ordering::SeqCst) {
            return;
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
                );
            });

            let monitor = Monitor::primary().expect("No primary monitor found");

            let capture_ctx = CaptureContext::new(
                work_tx,
                recycle_rx,
                is_running_clone.clone(),
                settings_arc,
            );

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
    }

    pub fn stop_capture(&self) {
        self.is_running.store(false, Ordering::SeqCst);
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

        let raw = RawFrame { buffer, width, height };

        if let Err(TrySendError::Full(returned)) = self.ctx.work_tx.try_send(raw) {
            let _ = self.ctx.recycle_rx.try_recv().unwrap_or(returned.buffer);
        }

        Ok(())
    }
}

fn run_encoder_loop(
    rx: Receiver<RawFrame>,
    recycle_tx: Sender<Vec<u8>>,
    tx_web: watch::Sender<StreamFrame>,
    settings: Arc<Mutex<StreamSettings>>,
    is_running: Arc<AtomicBool>,
) {
    let mut resizer = Resizer::new();
    let mut resized_storage = Vec::new();
    
    let mut compressor = Compressor::new().expect("Failed to create TurboJPEG compressor");
    let mut comp_buf = OutputBuf::new_owned(); 

    let mut frame_times: VecDeque<Instant> = VecDeque::new();

    while is_running.load(Ordering::SeqCst) {
        let Ok(raw) = rx.recv() else { break };

        // 1. Add current time
        let now = Instant::now();
        frame_times.push_back(now);

        // 2. Remove timestamps older than 1 second
        while let Some(&t) = frame_times.front() {
            if now.duration_since(t) > Duration::from_secs(1) {
                frame_times.pop_front();
            } else {
                break;
            }
        }

        // 3. The length of the queue is exactly how many frames happened in the last second
        let current_fps = frame_times.len() as u32;

        let (quality, scale_pct) = {
            let s = settings.lock().unwrap();
            (s.quality, s.resolution_percentage)
        };

        let mut final_width = raw.width;
        let mut final_height = raw.height;
        let mut final_pixels: &[u8] = &raw.buffer;

        if scale_pct < 100 {
            final_width = (raw.width * scale_pct as u32) / 100;
            final_height = (raw.height * scale_pct as u32) / 100;

            if final_width > 0 && final_height > 0 {
                let src = ImageRef::new(
                    raw.width,
                    raw.height,
                    &raw.buffer,
                    PixelType::U8x4,
                ).unwrap();

                let required = (final_width * final_height * 4) as usize;
                if resized_storage.len() < required {
                    resized_storage.resize(required, 0);
                }

                let mut dst = Image::from_slice_u8(
                    final_width,
                    final_height,
                    &mut resized_storage,
                    PixelType::U8x4,
                ).unwrap();

                let opts = ResizeOptions::new()
                    .resize_alg(fast_image_resize::ResizeAlg::Nearest);

                if resizer.resize(&src, &mut dst, &opts).is_ok() {
                    final_pixels = &resized_storage[..required];
                }
            }
        }

        let image = JpegImage {
            pixels: final_pixels,
            width: final_width as usize,
            height: final_height as usize,
            pitch: (final_width * 4) as usize,
            format: PixelFormat::BGRA, 
        };

        let _ = compressor.set_quality(quality as i32);
        let _ = compressor.set_subsamp(Subsamp::Sub2x2);

        if compressor.compress(image, &mut comp_buf).is_ok() {
             let _ = tx_web.send(StreamFrame {
                jpeg: Arc::new(comp_buf.to_vec()), 
                active_window: get_active_window_title(),
                actual_fps: current_fps, // This now updates every frame!
            });
        }

        let _ = recycle_tx.try_send(raw.buffer);
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