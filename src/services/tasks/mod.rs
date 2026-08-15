use crate::utils::units::bytes_to_mb_f64;
use anyhow::{Result, anyhow};
#[cfg(target_os = "windows")]
use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::Serialize;
use sysinfo::{Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use ts_rs::TS;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields = nullable)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_usage: f64,
    pub ppid: Option<u32>,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct ProcessDetails {
    pub pid: u32,
    pub name: String,
    pub rss_memory_mb: f64,
    pub exact_memory_mb: f64,
}

pub struct TaskManager {
    sys: RwLock<System>,
    networks: RwLock<Networks>,
    last_refresh: RwLock<std::time::Instant>,
    #[cfg(target_os = "windows")]
    cpu_tracker: Mutex<backend::CpuTracker>,
}

impl TaskManager {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        Self {
            sys: RwLock::new(sys),
            networks: RwLock::new(Networks::new_with_refreshed_list()),
            last_refresh: RwLock::new(
                std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(10))
                    .unwrap(),
            ),
            #[cfg(target_os = "windows")]
            cpu_tracker: Mutex::new(backend::CpuTracker::new()),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn cpu_usage(&self) -> f32 {
        self.cpu_tracker.lock().sample()
    }

    #[cfg(target_os = "linux")]
    pub fn global_cpu_usage(&self) -> f32 {
        self.sys.read().global_cpu_usage()
    }

    pub fn memory_usage_percent(&self) -> f64 {
        let sys = self.sys.read();
        let total = sys.total_memory() as f64;
        if total <= 0.0 {
            return 0.0;
        }
        (sys.used_memory() as f64 / total) * 100.0
    }

    pub fn with_sys<T>(&self, f: impl FnOnce(&System) -> T) -> T {
        f(&self.sys.read())
    }

    pub fn refresh_networks(&self) {
        self.networks.write().refresh(true);
    }

    pub fn with_networks<T>(&self, f: impl FnOnce(&Networks) -> T) -> T {
        f(&self.networks.read())
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

    pub fn get_processes(&self) -> Vec<ProcessInfo> {
        self.refresh_sysinfo_if_needed();

        #[cfg(target_os = "windows")]
        let pws_map = unsafe { backend::get_all_private_working_sets() };

        let sys = self.sys.read();
        let num_cpus = sys.cpus().len().max(1) as f32;
        let mut result: Vec<ProcessInfo> = Vec::new();

        for (pid, proc_info) in sys.processes() {
            let pid_u32 = pid.as_u32();

            if proc_info.name().to_string_lossy().is_empty() {
                continue;
            }

            #[cfg(not(target_os = "windows"))]
            let mut mem_mb = bytes_to_mb_f64(proc_info.memory());
            #[cfg(target_os = "windows")]
            let mut mem_mb = bytes_to_mb_f64(pws_map.get(&pid_u32).copied().unwrap_or(0));

            let mut cpu = proc_info.cpu_usage() / num_cpus;
            if cpu.is_nan() {
                cpu = 0.0;
            }
            if mem_mb.is_nan() {
                mem_mb = 0.0;
            }

            result.push(ProcessInfo {
                pid: pid_u32,
                name: proc_info.name().to_string_lossy().to_string(),
                cpu_percent: cpu,
                memory_usage: mem_mb,
                ppid: proc_info.parent().map(|p| p.as_u32()),
            });
        }

        result
    }

    pub fn get_process_details(&self, pid: u32) -> Result<ProcessDetails> {
        let sys = self.sys.read();
        let proc = sys
            .process(Pid::from_u32(pid))
            .ok_or_else(|| anyhow!("Process not found"))?;

        let rss_memory_mb = bytes_to_mb_f64(proc.memory());
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

        Ok(ProcessDetails {
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

    pub fn launch_process(&self, command: &str) -> Result<()> {
        let command = command.trim();
        if command.is_empty() {
            return Err(anyhow!("Command cannot be empty"));
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("cmd")
                .arg("/C")
                .raw_arg(command)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()?;
        }

        #[cfg(not(target_os = "windows"))]
        std::process::Command::new("sh").arg("-c").arg(command).spawn()?;

        Ok(())
    }
}
