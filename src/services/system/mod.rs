use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use sysinfo::{Networks, ProcessesToUpdate, System};

fn get_local_ip() -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0")
        && socket.connect("8.8.8.8:80").is_ok()
        && let Ok(addr) = socket.local_addr()
    {
        return addr.ip().to_string();
    }
    "127.0.0.1".to_string()
}

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
    pub gpu: String,
    pub monitors: String,
    pub disks: String,
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
    pub antivirus: String,
    pub firewall: String,
    pub timezone: String,
    pub country: String,
    pub disk_total: String,
    pub disk_used: String,
    pub disk_free: String,
    pub active_processes: usize,
}

#[derive(Deserialize)]
struct IpApiConnect {
    ip: Option<String>,
    asn: Option<AsnData>,
    location: Option<LocationData>,
}

#[derive(Deserialize)]
struct AsnData {
    asn: Option<u32>,
    org: Option<String>,
}

#[derive(Deserialize)]
struct LocationData {
    country: Option<String>,
    timezone: Option<String>,
}

fn get_cpu_base_speed(brand: &str) -> String {
    if let Some(idx) = brand.find('@') {
        return brand[idx + 1..].trim().to_string();
    }
    "N/A".to_string()
}

async fn fetch_wan_info() -> (String, String, String, String, String) {
    let result = tokio::task::spawn_blocking(|| {
        minreq::get("https://api.ipapi.is/")
            .with_timeout(3)
            .send()
            .and_then(|resp| resp.json::<IpApiConnect>())
    })
    .await;

    match result {
        Ok(Ok(data)) => {
            let ip = data.ip.unwrap_or("N/A".to_string());
            let asn = data
                .asn
                .as_ref()
                .map(|a| a.asn.unwrap_or(0).to_string())
                .unwrap_or("N/A".to_string());
            let isp = data
                .asn
                .as_ref()
                .and_then(|a| a.org.clone())
                .unwrap_or("N/A".to_string());
            let country = data
                .location
                .as_ref()
                .and_then(|l| l.country.clone())
                .unwrap_or("N/A".to_string());
            let timezone = data
                .location
                .as_ref()
                .and_then(|l| l.timezone.clone())
                .unwrap_or("N/A".to_string());

            (ip, asn, isp, country, timezone)
        }
        _ => na_wan_info(),
    }
}

fn na_wan_info() -> (String, String, String, String, String) {
    (
        "N/A".to_string(),
        "N/A".to_string(),
        "N/A".to_string(),
        "N/A".to_string(),
        "N/A".to_string(),
    )
}

fn get_mac_address(net_lock: &Arc<RwLock<Networks>>) -> String {
    let networks = net_lock.read().unwrap();
    for data in networks.values() {
        let mac = data.mac_address().to_string();
        if mac != "00:00:00:00:00:00" && mac != "00:00:00:00:00:00:00:00" {
            return mac.to_uppercase().replace(":", "-");
        }
    }
    "N/A".to_string()
}

fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;
    format!("{}d : {}h : {}m : {}s", days, hours, minutes, secs)
}

fn get_disk_usage() -> (u64, u64, u64) {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy();
        if mount == "/" || mount.starts_with("C:") {
            let total = disk.total_space() / 1024 / 1024 / 1024;
            let free = disk.available_space() / 1024 / 1024 / 1024;
            return (total, total.saturating_sub(free), free);
        }
    }
    (0, 0, 0)
}

pub(crate) struct SystemBaseInfo {
    pub memory_total_mb: u64,
    pub active_processes: usize,
    pub cpu_threads: usize,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub cpu_frequency: u64,
}

pub(crate) struct OsSpecificInfo {
    pub os: String,
    pub gpu: String,
    pub monitors: String,
    pub disks: String,
    pub battery: String,
    pub domain: String,
    pub system_drive: String,
    pub system_dir: String,
    pub antivirus: String,
    pub firewall: String,
    pub cpu_max_speed: String,
}

pub(crate) fn refresh_system_info(sys_lock: &Arc<RwLock<System>>, net_lock: &Arc<RwLock<Networks>>) -> SystemBaseInfo {
    {
        let mut sys = sys_lock.write().unwrap();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes(ProcessesToUpdate::All, true);
    }

    {
        let mut networks = net_lock.write().unwrap();
        networks.refresh(true);
    }

    let (memory_total_mb, active_processes, cpu_threads, cpu_brand, cpu_frequency) = {
        let sys = sys_lock.read().unwrap();
        (
            sys.total_memory() / 1024 / 1024,
            sys.processes().len(),
            sys.cpus().len(),
            sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
            sys.cpus().first().map(|c| c.frequency()).unwrap_or(0),
        )
    };

    let cpu_cores = System::physical_core_count().unwrap_or(0);

    SystemBaseInfo {
        memory_total_mb,
        active_processes,
        cpu_threads,
        cpu_brand,
        cpu_cores,
        cpu_frequency,
    }
}

pub async fn get_system_info(sys_lock: &Arc<RwLock<System>>, net_lock: &Arc<RwLock<Networks>>) -> SystemInfoDTO {
    let base = refresh_system_info(sys_lock, net_lock);
    let wan_info = fetch_wan_info().await;
    let lan_ip = get_local_ip();
    let mac = get_mac_address(net_lock);
    let username = whoami::username().unwrap_or_else(|_| "Unknown".to_string());
    let pc_name = whoami::devicename().unwrap_or_else(|_| "Unknown".to_string());
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    let os_info = get_os_specific_info(base.cpu_frequency).await;
    let (disk_total, disk_used, disk_free) = get_disk_usage();

    SystemInfoDTO {
        processor: base.cpu_brand.clone(),
        cpu_cores: base.cpu_cores.to_string(),
        cpu_threads: base.cpu_threads.to_string(),
        cpu_base_speed: get_cpu_base_speed(&base.cpu_brand),
        memory: format!("{} MB", base.memory_total_mb),
        username,
        pc_name,
        hostname,
        uptime: format_uptime(System::uptime()),
        mac_address: mac,
        lan_ip,
        wan_ip: wan_info.0,
        asn: wan_info.1,
        isp: wan_info.2,
        country: wan_info.3,
        timezone: wan_info.4,
        active_processes: base.active_processes,
        os: os_info.os,
        architecture: std::env::consts::ARCH.to_string(),
        gpu: os_info.gpu,
        monitors: os_info.monitors,
        disks: os_info.disks,
        battery: os_info.battery,
        domain: os_info.domain,
        system_drive: os_info.system_drive,
        system_dir: os_info.system_dir,
        antivirus: os_info.antivirus,
        firewall: os_info.firewall,
        cpu_max_speed: os_info.cpu_max_speed,
        disk_total: format!("{} GB", disk_total),
        disk_used: format!("{} GB", disk_used),
        disk_free: format!("{} GB", disk_free),
    }
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::get_os_specific_info;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::get_os_specific_info;
