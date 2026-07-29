use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use sysinfo::{Networks, System};
use ts_rs::TS;

const NA: &str = "N/A";

fn or_na(value: Option<String>) -> String {
    value.unwrap_or_else(|| NA.to_string())
}

pub(crate) fn join_or_na(items: &[String]) -> String {
    if items.is_empty() {
        NA.to_string()
    } else {
        items.join(", ")
    }
}

#[derive(Clone)]
pub struct WanInfo {
    pub ip: String,
    pub asn: String,
    pub isp: String,
    pub country: String,
    pub timezone: String,
}

impl WanInfo {
    pub fn na() -> Self {
        Self {
            ip: or_na(None),
            asn: or_na(None),
            isp: or_na(None),
            country: or_na(None),
            timezone: or_na(None),
        }
    }
}

fn get_local_ip() -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0")
        && socket.connect("8.8.8.8:80").is_ok()
        && let Ok(addr) = socket.local_addr()
    {
        return addr.ip().to_string();
    }
    "127.0.0.1".to_string()
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct SystemInfoDTO {
    pub os: String,
    pub architecture: String,
    pub processor: String,
    pub cpu_cores: usize,
    pub cpu_threads: usize,
    pub cpu_base_speed: String,
    pub cpu_max_speed_mhz: Option<u32>,
    pub memory_total_mb: u64,
    pub gpu: String,
    pub monitors: String,
    pub disks: String,
    pub battery: String,
    pub username: String,
    pub pc_name: String,
    pub domain: String,
    pub hostname: String,
    pub system_drive: String,
    pub uptime_seconds: u64,
    pub mac_address: String,
    pub lan_ip: String,
    pub wan_ip: String,
    pub asn: String,
    pub isp: String,
    pub antivirus: String,
    pub firewall: String,
    pub timezone: String,
    pub country: String,
    pub disk_total_gb: u64,
    pub disk_used_gb: u64,
    pub disk_free_gb: u64,
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
    NA.to_string()
}

async fn fetch_wan_info() -> Result<WanInfo, ()> {
    let result = tokio::task::spawn_blocking(|| {
        minreq::get("https://api.ipapi.is/")
            .with_timeout(3)
            .send()
            .and_then(|resp| resp.json::<IpApiConnect>())
    })
    .await;

    match result {
        Ok(Ok(data)) => {
            let ip = or_na(data.ip);
            let asn = or_na(data.asn.as_ref().map(|a| a.asn.unwrap_or(0).to_string()));
            let isp = or_na(data.asn.as_ref().and_then(|a| a.org.clone()));
            let country = or_na(data.location.as_ref().and_then(|l| l.country.clone()));
            let timezone = or_na(data.location.as_ref().and_then(|l| l.timezone.clone()));

            Ok(WanInfo {
                ip,
                asn,
                isp,
                country,
                timezone,
            })
        }
        _ => Err(()),
    }
}

fn get_mac_address(net_lock: &Arc<RwLock<Networks>>) -> String {
    let networks = net_lock.read();
    for data in networks.values() {
        let mac = data.mac_address().to_string();
        if mac != "00:00:00:00:00:00" && mac != "00:00:00:00:00:00:00:00" {
            return mac.to_uppercase().replace(":", "-");
        }
    }
    NA.to_string()
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
    pub antivirus: String,
    pub firewall: String,
    pub cpu_max_speed_mhz: Option<u32>,
}

pub(crate) fn refresh_system_info(sys_lock: &Arc<RwLock<System>>, net_lock: &Arc<RwLock<Networks>>) -> SystemBaseInfo {
    {
        let mut networks = net_lock.write();
        networks.refresh(true);
    }

    let (memory_total_mb, active_processes, cpu_threads, cpu_brand, cpu_frequency) = {
        let sys = sys_lock.read();
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

pub async fn get_system_info(state: &crate::state::AppState) -> SystemInfoDTO {
    let sys_lock = state.sys.clone();
    let net_lock = state.networks.clone();
    let tasks = state.tasks.clone();

    let (base, lan_ip, mac, username, pc_name, hostname, disk_total, disk_used, disk_free) =
        tokio::task::spawn_blocking(move || {
            tasks.refresh_sysinfo_if_needed();

            let base = refresh_system_info(&sys_lock, &net_lock);
            let lan_ip = get_local_ip();
            let mac = get_mac_address(&net_lock);
            let username = whoami::username().unwrap_or_else(|_| "Unknown".to_string());
            let pc_name = whoami::devicename().unwrap_or_else(|_| "Unknown".to_string());
            let hostname = hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "Unknown".to_string());
            let (disk_total, disk_used, disk_free) = get_disk_usage();

            (
                base, lan_ip, mac, username, pc_name, hostname, disk_total, disk_used, disk_free,
            )
        })
        .await
        .unwrap();

    let wan_info = match state.wan_info.get_or_try_init(fetch_wan_info).await {
        Ok(info) => info.clone(),
        Err(_) => WanInfo::na(),
    };
    let WanInfo {
        ip: wan_ip,
        asn,
        isp,
        country,
        timezone,
    } = wan_info;

    let os_info = backend::get_os_specific_info(base.cpu_frequency).await;

    SystemInfoDTO {
        processor: base.cpu_brand.clone(),
        cpu_cores: base.cpu_cores,
        cpu_threads: base.cpu_threads,
        cpu_base_speed: get_cpu_base_speed(&base.cpu_brand),
        memory_total_mb: base.memory_total_mb,
        username,
        pc_name,
        hostname,
        uptime_seconds: System::uptime(),
        mac_address: mac,
        lan_ip,
        wan_ip,
        asn,
        isp,
        country,
        timezone,
        active_processes: base.active_processes,
        os: os_info.os,
        architecture: std::env::consts::ARCH.to_string(),
        gpu: os_info.gpu,
        monitors: os_info.monitors,
        disks: os_info.disks,
        battery: os_info.battery,
        domain: os_info.domain,
        system_drive: os_info.system_drive,
        antivirus: os_info.antivirus,
        firewall: os_info.firewall,
        cpu_max_speed_mhz: os_info.cpu_max_speed_mhz,
        disk_total_gb: disk_total,
        disk_used_gb: disk_used,
        disk_free_gb: disk_free,
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;
