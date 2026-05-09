use anyhow::{Result, anyhow};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[derive(Serialize, Clone)]
pub struct ProcessDTO {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_usage: f64,
    pub ppid: Option<u32>,
    pub is_group: bool,
    pub children: Vec<ProcessDTO>,
}

pub struct TaskManager {
    sys: Arc<Mutex<System>>,
}

impl TaskManager {
    pub fn new(sys: Arc<Mutex<System>>) -> Self {
        Self { sys }
    }

    pub fn get_processes(&self) -> Vec<ProcessDTO> {
        let mut sys = self.sys.lock().unwrap();

        sys.refresh_processes(ProcessesToUpdate::All, true);

        let mut groups: HashMap<String, ProcessDTO> = HashMap::new();

        for (pid, proc) in sys.processes() {
            if proc.name().to_string_lossy().is_empty() {
                continue;
            }

            let mem_mb = proc.memory() as f64 / 1024.0 / 1024.0;
            let cpu = proc.cpu_usage();
            let name = proc.name().to_string_lossy().to_string();

            let dto = ProcessDTO {
                pid: pid.as_u32(),
                name: name.clone(),
                cpu_percent: cpu,
                memory_usage: mem_mb,
                ppid: proc.parent().map(|p| p.as_u32()),
                is_group: false,
                children: vec![],
            };

            groups
                .entry(name)
                .and_modify(|group| {
                    if !group.is_group {
                        let first_child = group.clone();
                        group.is_group = true;
                        group.children.push(first_child);
                    }
                    group.children.push(dto.clone());
                    group.cpu_percent += dto.cpu_percent;
                    group.memory_usage += dto.memory_usage;
                })
                .or_insert(dto);
        }

        let mut result: Vec<ProcessDTO> = groups.into_values().collect();

        for proc in &mut result {
            if proc.is_group && proc.children.len() <= 1 {
                proc.is_group = false;
                proc.children.clear();
            }
        }

        result.sort_by(|a, b| b.cpu_percent.partial_cmp(&a.cpu_percent).unwrap());

        result
    }

    pub fn kill_process(&self, pid: u32) -> Result<()> {
        let sys = self.sys.lock().unwrap();
        if let Some(proc) = sys.process(Pid::from_u32(pid))
            && proc.kill()
        {
            return Ok(());
        }
        Err(anyhow!("Failed to kill process or process not found"))
    }
}
