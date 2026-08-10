use crate::utils::units::{BYTES_PER_MB, bytes_to_gb};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use sysinfo::{Networks, System};
use ts_rs::TS;

#[derive(Clone, Default)]
pub struct WanInfo {
    pub ip: Option<String>,
    pub asn: Option<String>,
    pub isp: Option<String>,
    pub country: Option<String>,
    pub timezone: Option<String>,
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
pub struct IdentityInfo {
    pub os: String,
    pub architecture: String,
    pub username: String,
    pub pc_name: String,
    pub domain: Option<String>,
    pub hostname: String,
    pub uptime_seconds: u64,
    pub timezone: Option<String>,
    pub country: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct HardwareInfo {
    pub processor: String,
    pub cpu_cores: usize,
    pub cpu_threads: usize,
    pub cpu_base_speed: Option<String>,
    pub cpu_max_speed_mhz: Option<u32>,
    pub memory_total_mb: u64,
    pub gpu: Vec<String>,
    pub monitors: Vec<String>,
    pub battery: String,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct NetworkInfo {
    pub mac_address: Option<String>,
    pub lan_ip: String,
    pub wan_ip: Option<String>,
    pub asn: Option<String>,
    pub isp: Option<String>,
    pub antivirus: Vec<String>,
    pub firewall: String,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct StorageInfo {
    pub disks: Vec<String>,
    pub system_drive: String,
    pub disk_total_gb: u64,
    pub disk_used_gb: u64,
    pub disk_free_gb: u64,
    pub active_processes: usize,
}

#[derive(Serialize, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct SystemInfoDTO {
    pub identity: IdentityInfo,
    pub hardware: HardwareInfo,
    pub network: NetworkInfo,
    pub storage: StorageInfo,
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

fn get_cpu_base_speed(brand: &str) -> Option<String> {
    let idx = brand.find('@')?;
    Some(brand[idx + 1..].trim().to_string())
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
        Ok(Ok(data)) => Ok(WanInfo {
            ip: data.ip,
            asn: data.asn.as_ref().map(|a| a.asn.unwrap_or(0).to_string()),
            isp: data.asn.as_ref().and_then(|a| a.org.clone()),
            country: data.location.as_ref().and_then(|l| l.country.clone()),
            timezone: data.location.as_ref().and_then(|l| l.timezone.clone()),
        }),
        _ => Err(()),
    }
}

fn get_mac_address(net_lock: &Arc<RwLock<Networks>>) -> Option<String> {
    let networks = net_lock.read();
    for data in networks.values() {
        let mac = data.mac_address().to_string();
        if mac != "00:00:00:00:00:00" && mac != "00:00:00:00:00:00:00:00" {
            return Some(mac.to_uppercase().replace(":", "-"));
        }
    }
    None
}

pub(crate) fn disk_usage_from(disks: &sysinfo::Disks) -> (u64, u64, u64) {
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy();
        if mount == "/" || mount.starts_with("C:") {
            let total = bytes_to_gb(disk.total_space());
            let free = bytes_to_gb(disk.available_space());
            return (total, total.saturating_sub(free), free);
        }
    }
    (0, 0, 0)
}

pub(crate) fn format_disk_label(name: &str, bytes: u64) -> String {
    format!("{name} ({}GB)", bytes_to_gb(bytes))
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
    pub gpu: Vec<String>,
    pub monitors: Vec<String>,
    pub disks: Vec<String>,
    pub battery: String,
    pub domain: Option<String>,
    pub system_drive: String,
    pub antivirus: Vec<String>,
    pub firewall: String,
    pub cpu_max_speed_mhz: Option<u32>,
    pub disk_total_gb: u64,
    pub disk_used_gb: u64,
    pub disk_free_gb: u64,
}

pub(crate) fn refresh_system_info(sys_lock: &Arc<RwLock<System>>, net_lock: &Arc<RwLock<Networks>>) -> SystemBaseInfo {
    {
        let mut networks = net_lock.write();
        networks.refresh(true);
    }

    let (memory_total_mb, active_processes, cpu_threads, cpu_brand, cpu_frequency) = {
        let sys = sys_lock.read();
        (
            sys.total_memory() / BYTES_PER_MB,
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

    let (base, lan_ip, mac, username, pc_name, hostname) = tokio::task::spawn_blocking(move || {
        tasks.refresh_sysinfo_if_needed();

        let base = refresh_system_info(&sys_lock, &net_lock);
        let lan_ip = get_local_ip();
        let mac = get_mac_address(&net_lock);
        let username = whoami::username().unwrap_or_else(|_| "Unknown".to_string());
        let pc_name = whoami::devicename().unwrap_or_else(|_| "Unknown".to_string());
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Unknown".to_string());

        (base, lan_ip, mac, username, pc_name, hostname)
    })
    .await
    .unwrap();

    let wan_info = match state.wan_info.get_or_try_init(fetch_wan_info).await {
        Ok(info) => info.clone(),
        Err(_) => WanInfo::default(),
    };
    let WanInfo {
        ip: wan_ip,
        asn,
        isp,
        country,
        timezone,
    } = wan_info;

    let os_info = backend::get_os_specific_info(base.cpu_frequency).await;
    let cpu_base_speed = get_cpu_base_speed(&base.cpu_brand);

    SystemInfoDTO {
        identity: IdentityInfo {
            os: os_info.os,
            architecture: std::env::consts::ARCH.to_string(),
            username,
            pc_name,
            domain: os_info.domain,
            hostname,
            uptime_seconds: System::uptime(),
            timezone,
            country,
        },
        hardware: HardwareInfo {
            processor: base.cpu_brand,
            cpu_cores: base.cpu_cores,
            cpu_threads: base.cpu_threads,
            cpu_base_speed,
            cpu_max_speed_mhz: os_info.cpu_max_speed_mhz,
            memory_total_mb: base.memory_total_mb,
            gpu: os_info.gpu,
            monitors: os_info.monitors,
            battery: os_info.battery,
        },
        network: NetworkInfo {
            mac_address: mac,
            lan_ip,
            wan_ip,
            asn,
            isp,
            antivirus: os_info.antivirus,
            firewall: os_info.firewall,
        },
        storage: StorageInfo {
            disks: os_info.disks,
            system_drive: os_info.system_drive,
            disk_total_gb: os_info.disk_total_gb,
            disk_used_gb: os_info.disk_used_gb,
            disk_free_gb: os_info.disk_free_gb,
            active_processes: base.active_processes,
        },
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
