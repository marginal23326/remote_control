use anyhow::{Result, anyhow};
use serde::Serialize;
use std::sync::{Arc, RwLock};
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
    pub command_line: String,
}

pub struct TaskManager {
    sys: Arc<RwLock<System>>,
    last_refresh: RwLock<std::time::Instant>,
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
        }
    }

    pub fn get_processes(&self) -> Vec<ProcessDTO> {
        if let Ok(mut last) = self.last_refresh.write()
            && last.elapsed() > std::time::Duration::from_millis(1500)
        {
            self.sys
                .write()
                .unwrap()
                .refresh_processes(ProcessesToUpdate::All, true);
            *last = std::time::Instant::now();
        }

        let sys = self.sys.read().unwrap();
        let mut result: Vec<ProcessDTO> = Vec::new();

        for (pid, proc_info) in sys.processes() {
            let pid_u32 = pid.as_u32();

            if proc_info.name().to_string_lossy().is_empty() {
                continue;
            }

            let mut mem_mb = proc_info.memory() as f64 / 1024.0 / 1024.0;

            #[cfg(target_os = "linux")]
            {
                let status_path = format!("/proc/{}/status", pid_u32);
                if let Ok(content) = std::fs::read_to_string(&status_path) {
                    let mut tgid = None;
                    for line in content.lines() {
                        if line.starts_with("Tgid:") {
                            tgid = line.split_whitespace().nth(1).and_then(|s| s.parse::<u32>().ok());
                            break;
                        }
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

        result.sort_by(|a, b| {
            b.memory_usage
                .partial_cmp(&a.memory_usage)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        result
    }

    pub fn get_process_details(&self, pid: u32) -> Result<ProcessDetailsDTO> {
        let sys = self.sys.read().unwrap();
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

        let command_line = proc
            .cmd()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(" ");

        Ok(ProcessDetailsDTO {
            pid,
            name: proc.name().to_string_lossy().to_string(),
            rss_memory_mb,
            exact_memory_mb,
            command_line,
        })
    }

    pub fn kill_process(&self, pid: u32) -> Result<()> {
        let sys = self.sys.read().unwrap();
        if let Some(proc) = sys.process(Pid::from_u32(pid))
            && proc.kill()
        {
            return Ok(());
        }
        Err(anyhow!("Failed to kill process or process not found"))
    }
}
