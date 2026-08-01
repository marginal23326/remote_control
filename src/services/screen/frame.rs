use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

pub(crate) struct RawFrame {
    pub buffer: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn take_or_recycle(cached: &mut Option<Vec<u8>>, recycle_rx: &Receiver<Vec<u8>>) -> Vec<u8> {
    cached.take().or_else(|| recycle_rx.try_recv().ok()).unwrap_or_default()
}

pub(crate) fn send_or_cache(work_tx: &Sender<RawFrame>, cached: &mut Option<Vec<u8>>, raw: RawFrame) {
    if let Err(err) = work_tx.try_send(raw) {
        *cached = Some(err.into_inner().buffer);
    }
}

pub(crate) struct RecycleBin {
    pub(crate) buffer: Option<Vec<u8>>,
    pub(crate) tx: Sender<Vec<u8>>,
}

impl AsRef<[u8]> for RecycleBin {
    fn as_ref(&self) -> &[u8] {
        self.buffer.as_ref().unwrap()
    }
}

impl AsMut<[u8]> for RecycleBin {
    fn as_mut(&mut self) -> &mut [u8] {
        self.buffer.as_mut().unwrap()
    }
}

impl Drop for RecycleBin {
    fn drop(&mut self) {
        if let Some(buf) = self.buffer.take() {
            let _ = self.tx.try_send(buf);
        }
    }
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

    pub(crate) fn should_process(&mut self, target_fps: u64, max_fps: u64) -> bool {
        if target_fps >= max_fps {
            return true;
        }

        let now = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / target_fps as f64);
        let elapsed = now.saturating_duration_since(self.last_arrival);

        self.last_arrival = now;
        self.accumulated += elapsed;

        if self.accumulated >= interval {
            self.accumulated -= interval;

            if self.accumulated >= interval {
                self.accumulated = Duration::ZERO;
            }

            true
        } else {
            false
        }
    }
}
