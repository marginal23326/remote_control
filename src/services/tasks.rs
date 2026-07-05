use anyhow::{Result, anyhow};
#[cfg(target_os = "windows")]
use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::collections::HashMap;
use std::sync::Arc;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Serialize, Clone)]
pub struct ProcessDTO {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_usage: f64,
    pub ppid: Option<u32>,
}

#[derive(Serialize)]
pub struct ProcessDetailsDTO {
    pub pid: u32,
    pub name: String,
    pub rss_memory_mb: f64,
    pub exact_memory_mb: f64,
}

// sysinfo's global_cpu_usage() is unreliable on Windows, so we sample directly.
#[cfg(target_os = "windows")]
struct CpuTracker {
    prev_total: u64,
    prev_busy: u64,
}

#[cfg(target_os = "windows")]
impl CpuTracker {
    fn new() -> Self {
        Self {
            prev_total: 0,
            prev_busy: 0,
        }
    }

    fn sample(&mut self) -> f32 {
        use std::mem;
        use windows::Win32::System::Threading::GetSystemTimes;

        unsafe {
            let (mut idle, mut kernel, mut user) = (mem::zeroed(), mem::zeroed(), mem::zeroed());
            let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));

            let idle = ((idle.dwHighDateTime as u64) << 32) | (idle.dwLowDateTime as u64);
            let kernel = ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
            let user = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
            let total = kernel + user;
            let busy = total - idle;

            let result = if self.prev_total == 0 {
                0.0
            } else {
                let dt_total = total.saturating_sub(self.prev_total);
                let dt_busy = busy.saturating_sub(self.prev_busy);
                if dt_total == 0 {
                    0.0
                } else {
                    (dt_busy as f64 / dt_total as f64 * 100.0) as f32
                }
            };

            self.prev_total = total;
            self.prev_busy = busy;
            result
        }
    }
}

#[cfg(target_os = "windows")]
unsafe fn get_all_private_working_sets() -> HashMap<u32, u64> {
    use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};

    let mut required_len: u32 = 0;
    unsafe {
        let _ = NtQuerySystemInformation(SystemProcessInformation, std::ptr::null_mut(), 0, &mut required_len);
    }

    let alloc_size = (required_len as usize) + 4096;
    let mut buffer: Vec<u8> = vec![0u8; alloc_size];

    let status = unsafe {
        NtQuerySystemInformation(
            SystemProcessInformation,
            buffer.as_mut_ptr() as *mut _,
            buffer.len() as u32,
            &mut required_len,
        )
    };

    if !status.is_ok() {
        return HashMap::new();
    }

    let mut map = HashMap::new();
    let mut offset = 0usize;
    loop {
        if offset + 0x58 > buffer.len() {
            break;
        }
        let next_offset = u32::from_ne_bytes(buffer[offset..offset + 4].try_into().unwrap()) as usize;
        let pid = usize::from_ne_bytes(buffer[offset + 0x50..offset + 0x58].try_into().unwrap()) as u32;
        let pws = i64::from_ne_bytes(buffer[offset + 0x08..offset + 0x10].try_into().unwrap());
        if pws > 0 {
            map.insert(pid, pws as u64);
        }
        if next_offset == 0 {
            break;
        }
        offset += next_offset;
    }
    map
}

pub struct TaskManager {
    sys: Arc<RwLock<System>>,
    last_refresh: RwLock<std::time::Instant>,
    #[cfg(target_os = "windows")]
    cpu_tracker: Mutex<CpuTracker>,
}

impl TaskManager {
    pub fn new(sys: Arc<RwLock<System>>) -> Self {
        Self {
            sys,
            last_refresh: RwLock::new(
                std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(10))
                    .unwrap(),
            ),
            #[cfg(target_os = "windows")]
            cpu_tracker: Mutex::new(CpuTracker::new()),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn cpu_usage(&self) -> f32 {
        self.cpu_tracker.lock().sample()
    }

    pub fn refresh_sysinfo_if_needed(&self) {
        let mut last = self.last_refresh.write();
        if last.elapsed() > std::time::Duration::from_millis(1500) {
            let mut sys = self.sys.write();

            #[cfg(target_os = "linux")]
            sys.refresh_cpu_usage();

            sys.refresh_memory();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_memory().with_cpu().without_tasks(),
            );

            *last = std::time::Instant::now();
        }
    }

    pub fn get_processes(&self) -> Vec<ProcessDTO> {
        self.refresh_sysinfo_if_needed();

        #[cfg(target_os = "windows")]
        let pws_map = unsafe { get_all_private_working_sets() };

        let sys = self.sys.read();
        let num_cpus = sys.cpus().len().max(1) as f32;
        let mut result: Vec<ProcessDTO> = Vec::new();

        for (pid, proc_info) in sys.processes() {
            let pid_u32 = pid.as_u32();

            if proc_info.name().to_string_lossy().is_empty() {
                continue;
            }

            #[cfg(not(target_os = "windows"))]
            let mut mem_mb = proc_info.memory() as f64 / 1024.0 / 1024.0;
            #[cfg(target_os = "windows")]
            let mut mem_mb = pws_map.get(&pid_u32).copied().unwrap_or(0) as f64 / 1024.0 / 1024.0;

            let mut cpu = proc_info.cpu_usage() / num_cpus;
            if cpu.is_nan() {
                cpu = 0.0;
            }
            if mem_mb.is_nan() {
                mem_mb = 0.0;
            }

            result.push(ProcessDTO {
                pid: pid_u32,
                name: proc_info.name().to_string_lossy().to_string(),
                cpu_percent: cpu,
                memory_usage: mem_mb,
                ppid: proc_info.parent().map(|p| p.as_u32()),
            });
        }

        result
    }

    pub fn get_process_details(&self, pid: u32) -> Result<ProcessDetailsDTO> {
        let sys = self.sys.read();
        let proc = sys
            .process(Pid::from_u32(pid))
            .ok_or_else(|| anyhow!("Process not found"))?;

        let rss_memory_mb = proc.memory() as f64 / 1024.0 / 1024.0;
        #[allow(unused_mut)]
        let mut exact_memory_mb = rss_memory_mb;

        #[cfg(target_os = "linux")]
        {
            if let Ok(smaps) = std::fs::read_to_string(format!("/proc/{}/smaps_rollup", pid)) {
                for line in smaps.lines() {
                    if line.starts_with("Pss:") {
                        if let Some(kb_str) = line.split_whitespace().nth(1)
                            && let Ok(kb) = kb_str.parse::<f64>()
                        {
                            exact_memory_mb = kb / 1024.0;
                        }
                        break;
                    }
                }
            }
        }

        Ok(ProcessDetailsDTO {
            pid,
            name: proc.name().to_string_lossy().to_string(),
            rss_memory_mb,
            exact_memory_mb,
        })
    }

    pub fn kill_process(&self, pid: u32) -> Result<()> {
        let sys = self.sys.read();
        if let Some(proc) = sys.process(Pid::from_u32(pid))
            && proc.kill()
        {
            return Ok(());
        }
        Err(anyhow!("Failed to kill process or process not found"))
    }
}
