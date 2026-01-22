use serde::Serialize;
use sysinfo::{System, Networks, ProcessesToUpdate};
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
pub struct SystemInfoDTO {
    pub os: String,
    pub architecture: String,
    pub processor: String,
    pub cpu_cores: String,
    pub cpu_threads: String,
    pub cpu_base_speed: String,
    pub cpu_max_speed: String,
    pub memory: String,
    pub gpu: Vec<String>,
    pub monitors: String,
    pub disks: Vec<String>,
    pub battery: String,
    pub username: String,
    pub pc_name: String,
    pub domain: String,
    pub hostname: String,
    pub system_drive: String,
    pub system_dir: String,
    pub uptime: String,
    pub mac_address: String,
    pub lan_ip: String,
    pub wan_ip: String,
    pub asn: String,
    pub isp: String,
    pub antivirus: Vec<String>,
    pub firewall: String,
    pub timezone: String,
    pub country: String,
    pub disk_total: String,
    pub disk_used: String,
    pub disk_free: String,
    pub active_processes: usize,
}

pub fn get_system_info(
    sys_lock: &Arc<Mutex<System>>, 
    net_lock: &Arc<Mutex<Networks>>
) -> SystemInfoDTO {
    let mut sys = sys_lock.lock().unwrap();
    let mut networks = net_lock.lock().unwrap();
    
    sys.refresh_cpu_all();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    networks.refresh(true);

    let os_name = System::name().unwrap_or("Unknown".to_string());
    let os_ver = System::os_version().unwrap_or("".to_string());
    
    let total_mem_gb = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    
    let cpu_name = sys.cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let cores = sysinfo::System::physical_core_count().unwrap_or(0).to_string();
    let threads = sys.cpus().len().to_string();

    // Placeholder for now (requires detailed disk analysis later)
    let disks: Vec<String> = vec!["Drive C: (System)".to_string()];

    let uptime_sec = System::uptime();
    let days = uptime_sec / 86400;
    let hours = (uptime_sec % 86400) / 3600;
    let minutes = (uptime_sec % 3600) / 60;
    let seconds = uptime_sec % 60;
    let uptime_str = format!("{}d : {}h : {}m : {}s", days, hours, minutes, seconds);

    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let username = whoami::username().unwrap_or("Unknown".to_string());
    let pc_name = whoami::devicename().unwrap_or("Unknown".to_string());
    let hostname = whoami::devicename().unwrap_or("Unknown".to_string());

    SystemInfoDTO {
        os: format!("{} {}", os_name, os_ver),
        architecture: std::env::consts::ARCH.to_string(),
        processor: cpu_name,
        cpu_cores: cores,
        cpu_threads: threads,
        cpu_base_speed: "N/A".to_string(),
        cpu_max_speed: "N/A".to_string(),
        memory: format!("{:.1} GB", total_mem_gb),
        gpu: vec!["Generic GPU".to_string()],
        monitors: "Primary Display".to_string(),
        disks,
        battery: "AC Power".to_string(),
        username,
        pc_name,
        domain: "WORKGROUP".to_string(),
        hostname,
        system_drive: "C:".to_string(),
        system_dir: "C:\\Windows\\System32".to_string(),
        uptime: uptime_str,
        mac_address: "00:00:00:00:00:00".to_string(),
        lan_ip,
        wan_ip: "127.0.0.1".to_string(),
        asn: "Local".to_string(),
        isp: "Local Network".to_string(),
        antivirus: vec!["Windows Defender".to_string()],
        firewall: "Enabled".to_string(),
        timezone: "UTC".to_string(),
        country: "Local".to_string(),
        disk_total: "0 GB".to_string(),
        disk_used: "0 GB".to_string(),
        disk_free: "0 GB".to_string(),
        active_processes: sys.processes().len(),
    }
}