use parking_lot::Mutex;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

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

pub trait Stoppable: Sized {
    fn stop(self);
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

pub struct OwnedSession<T: Stoppable> {
    inner: Mutex<Option<T>>,
    ownership: StreamOwnership,
}

impl<T: Stoppable> Default for OwnedSession<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Stoppable> OwnedSession<T> {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            ownership: StreamOwnership::new(),
        }
    }

    pub fn ownership(&self) -> &StreamOwnership {
        &self.ownership
    }

    pub fn finish_start(&self, state: T) -> Result<(), T> {
        let mut guard = self.inner.lock();
        if !self.ownership.is_running() {
            return Err(state);
        }
        *guard = Some(state);
        Ok(())
    }

    pub fn with_inner<R>(&self, f: impl FnOnce(&T) -> R) -> Option<R> {
        self.inner.lock().as_ref().map(f)
    }

    pub fn stop(&self) {
        self.ownership.clear();
        if let Some(state) = self.inner.lock().take() {
            state.stop();
        }
    }

    pub fn stop_if_owner(&self, owner_id: &str) -> bool {
        let is_owner = self.ownership.owns(owner_id);
        if is_owner {
            self.stop();
        }
        is_owner
    }

    pub fn disconnect_if_owner(&self, owner_id: &str) -> bool {
        self.stop_if_owner(owner_id)
    }
}
