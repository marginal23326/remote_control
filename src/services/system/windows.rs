use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use sysinfo::{Networks, ProcessesToUpdate, System};
use tokio::process::Command;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
use windows::core::{HSTRING, PCWSTR};

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
    // 1. Refresh Dynamic Data
    {
        let mut sys = sys_lock.lock().unwrap();
        let mut networks = net_lock.lock().unwrap();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        networks.refresh(true);
    }

    let (memory_total_mb, active_processes, cpu_threads, cpu_brand) = {
        let sys = sys_lock.lock().unwrap();
        (
            sys.total_memory() / 1024 / 1024,
            sys.processes().len(),
            sys.cpus().len(),
            sys.cpus()
                .first()
                .map(|c| c.brand().to_string())
                .unwrap_or_default(),
        )
    };

    let cpu_cores = System::physical_core_count().unwrap_or(0);

    // 2. Hardware Info (Async / WMIC)
    let (gpu_info, disk_model_info, antivirus_info, cpu_max_speed_info) = tokio::join!(
        run_wmic_command("path win32_VideoController get name"),
        run_wmic_command("diskdrive get Model,Size"),
        run_wmic_command(
            r"/namespace:\\root\SecurityCenter2 path AntiVirusProduct get displayName"
        ),
        run_wmic_command("cpu get MaxClockSpeed")
    );

    // CPU Speeds
    let cpu_base = get_cpu_base_speed(&cpu_brand);
    let cpu_max = parse_wmic_cpu_speed(&cpu_max_speed_info);

    // 3. Windows Specifics
    let os_edition = get_windows_product_name().unwrap_or_else(|| "Windows".to_string());
    let (screen_w, screen_h) =
        unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };

    // 4. Battery
    let battery_status = get_battery_status();

    // 5. Network (Async HTTP)
    let wan_info = fetch_wan_info().await;
    let lan_ip = local_ip_address::local_ip()
        .map(|i| i.to_string())
        .unwrap_or("127.0.0.1".to_string());
    let mac = get_mac_address(net_lock);

    // 6. User & Host Info

    let username = whoami::username().unwrap_or_else(|_| "Unknown".to_string());
    let pc_name = whoami::devicename().unwrap_or_else(|_| "Unknown".to_string());
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());
    let domain = std::env::var("USERDOMAIN")
        .or_else(|_| std::env::var("userdomain"))
        .unwrap_or_else(|_| "WORKGROUP".to_string());

    // 7. Disk Usage (C:)
    let (d_total, d_used, d_free) = get_c_drive_usage();

    // 8. Uptime
    let uptime = format_uptime(System::uptime());

    SystemInfoDTO {
        os: os_edition,
        architecture: "64-bit".to_string(),
        processor: cpu_brand,
        cpu_cores: cpu_cores.to_string(),
        cpu_threads: cpu_threads.to_string(),
        cpu_base_speed: cpu_base,
        cpu_max_speed: cpu_max,
        memory: format!("{} MB", memory_total_mb),
        gpu: clean_wmic_list(&gpu_info),
        monitors: format!("Display ({}x{})", screen_w, screen_h),
        disks: parse_disk_info(&disk_model_info),
        battery: battery_status,
        username,
        pc_name,
        hostname,
        domain,
        system_drive: "C:".to_string(),
        system_dir: r"C:\WINDOWS\system32".to_string(),
        uptime,
        mac_address: mac,
        lan_ip,
        wan_ip: wan_info.0,
        asn: wan_info.1,
        isp: wan_info.2,
        antivirus: clean_wmic_list(&antivirus_info),
        firewall: get_firewall_status().await,
        timezone: wan_info.4,
        country: wan_info.3,
        disk_total: format!("{} GB", d_total),
        disk_used: format!("{} GB", d_used),
        disk_free: format!("{} GB", d_free),
        active_processes,
    }
}

// --- HELPER FUNCTIONS ---

async fn run_wmic_command(args: &str) -> String {
    let output = Command::new("cmd")
        .args(["/C", "wmic"])
        .raw_arg(args)
        .creation_flags(0x08000000)
        .output()
        .await;

    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    }
}

fn clean_wmic_list(output: &str) -> String {
    let mut items = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.to_lowercase().contains("name")
            || trimmed.to_lowercase().contains("displayname")
            || trimmed.contains("AntiVirusProduct")
        {
            continue;
        }
        if !items.contains(&trimmed.to_string()) {
            items.push(trimmed.to_string());
        }
    }
    if items.is_empty() {
        "N/A".to_string()
    } else {
        items.join(", ")
    }
}

fn parse_disk_info(output: &str) -> String {
    let mut disks = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.to_lowercase().contains("model") {
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 2 {
            // WMIC output puts size at the end usually
            let size_str = parts.last().unwrap();
            let model = parts[..parts.len() - 1].join(" ");

            if let Ok(bytes) = size_str.parse::<u64>() {
                let gb = bytes / 1024 / 1024 / 1024;
                disks.push(format!("{} ({}GB)", model, gb));
            } else {
                disks.push(model);
            }
        }
    }
    if disks.is_empty() {
        "N/A".to_string()
    } else {
        disks.join(", ")
    }
}

fn get_windows_product_name() -> Option<String> {
    unsafe {
        let subkey = HSTRING::from("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
        let value = HSTRING::from("ProductName");
        let mut buffer = [0u16; 256];
        let mut size = (buffer.len() * 2) as u32;

        let result = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut _),
            Some(&mut size),
        );

        if result.is_ok() {
            let len = (size / 2) - 1;
            Some(String::from_utf16_lossy(&buffer[..len as usize]))
        } else {
            None
        }
    }
}

fn get_battery_status() -> String {
    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            match status.ACLineStatus {
                0 => {
                    let pct = status.BatteryLifePercent;
                    if pct == 255 {
                        "Battery (Unknown %)".to_string()
                    } else {
                        format!("Discharging ({}% remaining)", pct)
                    }
                }
                1 => "No battery detected".to_string(),
                _ => "Unknown".to_string(),
            }
        } else {
            "Unknown".to_string()
        }
    }
}

fn get_cpu_base_speed(brand: &str) -> String {
    if let Some(idx) = brand.find('@') {
        return brand[idx + 1..].trim().to_string();
    }
    "N/A".to_string()
}

fn parse_wmic_cpu_speed(output: &str) -> String {
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.chars().all(char::is_numeric) && !trimmed.is_empty() {
            if let Ok(mhz) = trimmed.parse::<f64>() {
                return format!("{:.2} GHz", mhz / 1000.0);
            }
        }
    }
    "N/A".to_string()
}

async fn fetch_wan_info() -> (String, String, String, String, String) {
    let client = reqwest::Client::new();
    match client
        .get("https://api.ipapi.is/")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(resp) => {
            if let Ok(data) = resp.json::<IpApiConnect>().await {
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
            } else {
                (
                    "N/A".to_string(),
                    "N/A".to_string(),
                    "N/A".to_string(),
                    "N/A".to_string(),
                    "N/A".to_string(),
                )
            }
        }
        Err(_) => (
            "N/A".to_string(),
            "N/A".to_string(),
            "N/A".to_string(),
            "N/A".to_string(),
            "N/A".to_string(),
        ),
    }
}

async fn get_firewall_status() -> String {
    let output = run_wmic_command("path HNetCfg.FwMgr get CurrentProfileType").await;
    // If output has a number (profile type), firewall is effectively "On" or at least active.
    if !output.trim().is_empty() {
        "Enabled".to_string()
    } else {
        "Disabled".to_string()
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

fn get_c_drive_usage() -> (u64, u64, u64) {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    for disk in disks.list() {
        if disk.mount_point().to_string_lossy().starts_with("C:") {
            let total = disk.total_space() / 1024 / 1024 / 1024;
            let free = disk.available_space() / 1024 / 1024 / 1024;
            return (total, total - free, free);
        }
    }
    (0, 0, 0)
}

fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86400;
    let hours = (seconds % 86400) / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;
    format!("{}d : {}h : {}m : {}s", days, hours, minutes, secs)
}
