use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use sysinfo::{Networks, ProcessesToUpdate, System};
use tokio::process::Command;

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

pub async fn get_system_info(
    sys_lock: &Arc<Mutex<System>>,
    net_lock: &Arc<Mutex<Networks>>,
) -> SystemInfoDTO {
    {
        let mut sys = sys_lock.lock().unwrap();
        let mut networks = net_lock.lock().unwrap();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        networks.refresh(true);
    }

    let (memory_total_mb, active_processes, cpu_threads, cpu_brand, cpu_frequency) = {
        let sys = sys_lock.lock().unwrap();
        (
            sys.total_memory() / 1024 / 1024,
            sys.processes().len(),
            sys.cpus().len(),
            sys.cpus()
                .first()
                .map(|c| c.brand().to_string())
                .unwrap_or_else(|| "Unknown".to_string()),
            sys.cpus().first().map(|c| c.frequency()).unwrap_or(0),
        )
    };

    let cpu_cores = System::physical_core_count().unwrap_or(0);
    let wan_info = fetch_wan_info().await;
    let lan_ip = local_ip_address::local_ip()
        .map(|i| i.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let mac = get_mac_address(net_lock);
    let (disk_total, disk_used, disk_free, disks) = get_disk_info();

    SystemInfoDTO {
        os: linux_os_name(),
        architecture: std::env::consts::ARCH.to_string(),
        processor: cpu_brand.clone(),
        cpu_cores: cpu_cores.to_string(),
        cpu_threads: cpu_threads.to_string(),
        cpu_base_speed: get_cpu_base_speed(&cpu_brand),
        cpu_max_speed: if cpu_frequency > 0 {
            format!("{:.2} GHz", cpu_frequency as f64 / 1000.0)
        } else {
            "N/A".to_string()
        },
        memory: format!("{} MB", memory_total_mb),
        gpu: read_gpu_info(),
        monitors: read_monitor_info(),
        disks,
        battery: read_battery_status(),
        username: whoami::username().unwrap_or_else(|_| "Unknown".to_string()),
        pc_name: whoami::devicename().unwrap_or_else(|_| "Unknown".to_string()),
        domain: "N/A".to_string(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "Unknown".to_string()),
        system_drive: "/".to_string(),
        system_dir: "/usr/bin".to_string(),
        uptime: format_uptime(System::uptime()),
        mac_address: mac,
        lan_ip,
        wan_ip: wan_info.0,
        asn: wan_info.1,
        isp: wan_info.2,
        antivirus: "N/A".to_string(),
        firewall: get_firewall_status().await,
        timezone: wan_info.4,
        country: wan_info.3,
        disk_total: format!("{} GB", disk_total),
        disk_used: format!("{} GB", disk_used),
        disk_free: format!("{} GB", disk_free),
        active_processes,
    }
}

fn read_monitor_info() -> String {
    let mut resolutions = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let status_path = entry.path().join("status");
            let Ok(status) = std::fs::read_to_string(&status_path) else { continue };
            if status.trim() != "connected" { continue; }
            let modes_path = entry.path().join("modes");
            let Ok(modes) = std::fs::read_to_string(&modes_path) else { continue };
            if let Some(mode) = modes.lines().next().filter(|m| !m.is_empty()) {
                resolutions.push(mode.to_string());
            }
        }
    }
    if resolutions.is_empty() {
        "N/A".to_string()
    } else {
        resolutions.join(", ")
    }
}

fn linux_os_name() -> String {
    let name = System::long_os_version()
        .or_else(System::name)
        .unwrap_or_else(|| "Linux".to_string());
    let kernel = System::kernel_version().unwrap_or_default();
    if kernel.is_empty() {
        name
    } else {
        format!("{name} ({kernel})")
    }
}

fn get_cpu_base_speed(brand: &str) -> String {
    if let Some(idx) = brand.find('@') {
        return brand[idx + 1..].trim().to_string();
    }
    "N/A".to_string()
}

fn get_disk_info() -> (u64, u64, u64, String) {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut labels = Vec::new();
    let mut root = (0, 0, 0);

    for disk in disks.list() {
        let total = disk.total_space() / 1024 / 1024 / 1024;
        let free = disk.available_space() / 1024 / 1024 / 1024;
        let used = total.saturating_sub(free);
        labels.push(format!("{} ({total}GB)", disk.name().to_string_lossy()));
        if disk.mount_point() == Path::new("/") {
            root = (total, used, free);
        }
    }

    if root == (0, 0, 0) {
        root = disks
            .list()
            .first()
            .map(|disk| {
                let total = disk.total_space() / 1024 / 1024 / 1024;
                let free = disk.available_space() / 1024 / 1024 / 1024;
                (total, total.saturating_sub(free), free)
            })
            .unwrap_or((0, 0, 0));
    }

    (
        root.0,
        root.1,
        root.2,
        if labels.is_empty() {
            "N/A".to_string()
        } else {
            labels.join(", ")
        },
    )
}

fn read_battery_status() -> String {
    let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else {
        return "Unknown".to_string();
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = std::fs::read_to_string(path.join("type")) else {
            continue;
        };
        if kind.trim() != "Battery" {
            continue;
        }

        let capacity = std::fs::read_to_string(path.join("capacity"))
            .unwrap_or_else(|_| "Unknown".to_string());
        let status =
            std::fs::read_to_string(path.join("status")).unwrap_or_else(|_| "Battery".to_string());
        return format!("{} ({}% remaining)", status.trim(), capacity.trim());
    }

    "No battery detected".to_string()
}

fn read_gpu_info() -> String {
    let Ok(output) = std::process::Command::new("sh")
        .arg("-c")
        .arg("command -v lspci >/dev/null 2>&1 && lspci | grep -Ei 'vga|3d|display' || true")
        .output()
    else {
        return "N/A".to_string();
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let devices: Vec<String> = text
        .lines()
        .filter_map(|line| {
            line.split_once(':')
                .map(|(_, rest)| rest.trim().to_string())
        })
        .filter(|line| !line.is_empty())
        .collect();

    if devices.is_empty() {
        "N/A".to_string()
    } else {
        devices.join(", ")
    }
}

async fn fetch_wan_info() -> (String, String, String, String, String) {
    let result = tokio::task::spawn_blocking(|| {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(3)))
            .build()
            .into();
        agent
            .get("https://api.ipapi.is/")
            .call()
            .and_then(|mut resp| resp.body_mut().read_json::<IpApiConnect>())
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

async fn get_firewall_status() -> String {
    match Command::new("firewall-cmd").arg("--state").output().await {
        Ok(output) if output.status.success() => {
            let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if state.is_empty() {
                "Unknown".to_string()
            } else {
                state
            }
        }
        Ok(_) => "Disabled".to_string(),
        Err(_) => "Unknown".to_string(),
    }
}

fn get_mac_address(net_lock: &Arc<Mutex<Networks>>) -> String {
    let networks = net_lock.lock().unwrap();
    for (_, data) in networks.iter() {
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
