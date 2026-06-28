use anyhow::{Result, anyhow};
#[cfg(target_os = "windows")]
use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::Serialize;
use std::sync::Arc;
use sysinfo::{Pid, ProcessesToUpdate, System};

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
            sys.refresh_processes(ProcessesToUpdate::All, true);

            *last = std::time::Instant::now();
        }
    }

    pub fn get_processes(&self) -> Vec<ProcessDTO> {
        self.refresh_sysinfo_if_needed();

        let sys = self.sys.read();
        let mut result: Vec<ProcessDTO> = Vec::new();

        #[cfg(target_os = "linux")]
        let mut line_buf = String::with_capacity(64);

        for (pid, proc_info) in sys.processes() {
            let pid_u32 = pid.as_u32();

            if proc_info.name().to_string_lossy().is_empty() {
                continue;
            }

            let mut mem_mb = proc_info.memory() as f64 / 1024.0 / 1024.0;

            #[cfg(target_os = "linux")]
            {
                let status_path = format!("/proc/{}/status", pid_u32);
                if let Ok(file) = std::fs::File::open(&status_path) {
                    use std::io::BufRead;
                    let mut reader = std::io::BufReader::with_capacity(128, file);
                    let mut tgid = None;

                    line_buf.clear();
                    while reader.read_line(&mut line_buf).unwrap_or(0) > 0 {
                        if let Some(rest) = line_buf.strip_prefix("Tgid:") {
                            tgid = rest.trim().parse::<u32>().ok();
                            break;
                        }
                        line_buf.clear();
                    }

                    if let Some(t) = tgid
                        && t != pid_u32
                    {
                        continue;
                    }
                }
            }

            let mut cpu = proc_info.cpu_usage();
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
