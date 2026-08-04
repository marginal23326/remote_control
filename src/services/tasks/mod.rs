use crate::utils::units::bytes_to_mb_f64;
use anyhow::{Result, anyhow};
#[cfg(target_os = "windows")]
use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::Serialize;
use std::sync::Arc;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use ts_rs::TS;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

#[derive(Serialize, Clone, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields = nullable)]
pub struct ProcessDTO {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_usage: f64,
    pub ppid: Option<u32>,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct ProcessDetailsDTO {
    pub pid: u32,
    pub name: String,
    pub rss_memory_mb: f64,
    pub exact_memory_mb: f64,
}

pub struct TaskManager {
    sys: Arc<RwLock<System>>,
    last_refresh: RwLock<std::time::Instant>,
    #[cfg(target_os = "windows")]
    cpu_tracker: Mutex<backend::CpuTracker>,
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
            cpu_tracker: Mutex::new(backend::CpuTracker::new()),
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
        let pws_map = unsafe { backend::get_all_private_working_sets() };

        let sys = self.sys.read();
        let num_cpus = sys.cpus().len().max(1) as f32;
        let mut result: Vec<ProcessDTO> = Vec::new();

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
