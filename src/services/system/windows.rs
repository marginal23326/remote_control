use tokio::process::Command;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
use windows::core::{HSTRING, PCWSTR};

use super::OsSpecificInfo;

pub(crate) async fn get_os_specific_info(_cpu_frequency: u64) -> OsSpecificInfo {
    let (gpu_info, disk_model_info, antivirus_info, cpu_max_speed_info) = tokio::join!(
        run_wmic_command("path win32_VideoController get name"),
        run_wmic_command("diskdrive get Model,Size"),
        run_wmic_command(r"/namespace:\\root\SecurityCenter2 path AntiVirusProduct get displayName"),
        run_wmic_command("cpu get MaxClockSpeed")
    );

    let cpu_max_speed = parse_wmic_cpu_speed(&cpu_max_speed_info);
    let os_edition = get_windows_product_name().unwrap_or_else(|| "Windows".to_string());
    let (screen_w, screen_h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    let battery_status = get_battery_status();
    let domain = std::env::var("USERDOMAIN")
        .or_else(|_| std::env::var("userdomain"))
        .unwrap_or_else(|_| "WORKGROUP".to_string());

    OsSpecificInfo {
        os: os_edition,
        gpu: clean_wmic_list(&gpu_info),
        monitors: format!("Display ({}x{})", screen_w, screen_h),
        disks: parse_disk_info(&disk_model_info),
        battery: battery_status,
        domain,
        system_drive: "C:".to_string(),
        system_dir: r"C:\WINDOWS\system32".to_string(),
        antivirus: clean_wmic_list(&antivirus_info),
        firewall: get_firewall_status().await,
        cpu_max_speed,
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
            let size_str = parts.last().unwrap();
            let model = parts[..parts.len() - 1].join(" ");

            if let Ok(bytes) = size_str.parse::<u64>() {
                let gb = bytes / 1024 / 1024 / 1024;
                disks.push(format!("{} ({}GB)", model, gb));
            } else {
                disks.push(trimmed.to_string());
            }
        } else {
            disks.push(trimmed.to_string());
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
        if GetSystemPowerStatus(&mut status).is_err() {
            return "Unknown".to_string();
        }

        if status.BatteryFlag & 128 != 0 {
            return "No battery detected".to_string();
        }

        let pct = status.BatteryLifePercent;
        let pct_str = if pct == 255 { "?" } else { &pct.to_string() };

        match status.ACLineStatus {
            0 => format!("On Battery ({}% remaining)", pct_str),
            1 => format!("Plugged In ({}%)", pct_str),
            _ => "Unknown".to_string(),
        }
    }
}

fn parse_wmic_cpu_speed(output: &str) -> String {
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.chars().all(char::is_numeric)
            && !trimmed.is_empty()
            && let Ok(mhz) = trimmed.parse::<f64>()
        {
            return format!("{:.2} GHz", mhz / 1000.0);
        }
    }
    "N/A".to_string()
}

async fn get_firewall_status() -> String {
    let output = run_wmic_command("path HNetCfg.FwMgr get CurrentProfileType").await;
    if !output.trim().is_empty() {
        "Enabled".to_string()
    } else {
        "Disabled".to_string()
    }
}
