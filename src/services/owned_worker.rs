use parking_lot::Mutex;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

#[derive(Default)]
struct Owner(Mutex<Option<String>>);

impl Owner {
    fn set(&self, owner_id: String) {
        *self.0.lock() = Some(owner_id);
    }

    fn clear(&self) {
        *self.0.lock() = None;
    }

    fn owns(&self, owner_id: &str) -> bool {
        self.0.lock().as_deref() == Some(owner_id)
    }
}

pub struct OwnedWorker {
    handle: Mutex<Option<(thread::JoinHandle<()>, Arc<AtomicBool>)>>,
    owner: Owner,
}

impl Default for OwnedWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl OwnedWorker {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            owner: Owner::default(),
        }
    }

    pub fn start(&self, owner_id: String, spawn: impl FnOnce(Arc<AtomicBool>) -> thread::JoinHandle<()>) {
        self.stop();
        self.owner.set(owner_id);
        let is_running = Arc::new(AtomicBool::new(true));
        *self.handle.lock() = Some((spawn(is_running.clone()), is_running));
    }

    pub fn stop(&self) {
        self.owner.clear();
        if let Some((handle, running)) = self.handle.lock().take() {
            running.store(false, Ordering::SeqCst);
            tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            });
        }
    }

    pub fn stop_if_owner(&self, owner_id: &str) -> bool {
        let is_owner = self.owner.owns(owner_id);
        if is_owner {
            self.stop();
        }
        is_owner
    }
}

pub struct StreamOwnership {
    is_running: Arc<AtomicBool>,
    owner_id: Owner,
}

impl Default for StreamOwnership {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamOwnership {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            owner_id: Owner::default(),
        }
    }

    pub fn try_start(&self, owner_id: String) -> Result<StartGuard<'_>, ()> {
        self.is_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| ())?;
        self.owner_id.set(owner_id);
        Ok(StartGuard {
            ownership: self,
            started: false,
        })
    }

    pub fn running_flag(&self) -> Arc<AtomicBool> {
        self.is_running.clone()
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    pub fn owns(&self, owner_id: &str) -> bool {
        self.owner_id.owns(owner_id)
    }

    pub fn clear(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        self.owner_id.clear();
    }
}

pub struct StartGuard<'a> {
    ownership: &'a StreamOwnership,
    started: bool,
}

impl StartGuard<'_> {
    pub fn mark_started(mut self) {
        self.started = true;
    }
}

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        if !self.started {
            tracing::warn!("Stream startup failed or was interrupted. Resetting is_running flag.");
            self.ownership.is_running.store(false, Ordering::SeqCst);
        }
    }
}
