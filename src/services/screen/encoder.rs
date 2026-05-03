use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{PixelType, ResizeOptions, Resizer};
use tokio::sync::watch;
use turbojpeg::{Compressor, Image as JpegImage, OutputBuf, PixelFormat, Subsamp};

use super::{RawFrame, StreamFrame, StreamSettings};

pub(crate) fn run_encoder_loop(
    rx: Receiver<RawFrame>,
    recycle_tx: Sender<Vec<u8>>,
    tx_web: watch::Sender<StreamFrame>,
    settings: Arc<Mutex<StreamSettings>>,
    is_running: Arc<AtomicBool>,
    active_window: fn() -> String,
) {
    let mut resizer = Resizer::new();
    let mut resized_storage = Vec::new();

    let mut compressor = Compressor::new().expect("Failed to create TurboJPEG compressor");
    let mut comp_buf = OutputBuf::new_owned();

    let mut frame_times: VecDeque<Instant> = VecDeque::new();

    while is_running.load(Ordering::SeqCst) {
        let Ok(raw) = rx.recv() else { break };

        let now = Instant::now();
        frame_times.push_back(now);

        while let Some(&t) = frame_times.front() {
            if now.duration_since(t) > Duration::from_secs(1) {
                frame_times.pop_front();
            } else {
                break;
            }
        }

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
                let src =
                    ImageRef::new(raw.width, raw.height, &raw.buffer, PixelType::U8x4).unwrap();

                let required = (final_width * final_height * 4) as usize;
                if resized_storage.len() < required {
                    resized_storage.resize(required, 0);
                }

                let mut dst = Image::from_slice_u8(
                    final_width,
                    final_height,
                    &mut resized_storage,
                    PixelType::U8x4,
                )
                .unwrap();

                let opts = ResizeOptions::new().resize_alg(fast_image_resize::ResizeAlg::Nearest);

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
                active_window: active_window(),
                actual_fps: current_fps,
            });
        }

        let _ = recycle_tx.try_send(raw.buffer);
    }
}
