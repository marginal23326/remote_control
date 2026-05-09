use sysinfo::System;
use tokio::process::Command;

use super::OsSpecificInfo;

pub(crate) async fn get_os_specific_info(cpu_frequency: u64) -> OsSpecificInfo {
    let disks = get_disk_labels();
    let cpu_max_speed = if cpu_frequency > 0 {
        format!("{:.2} GHz", cpu_frequency as f64 / 1000.0)
    } else {
        "N/A".to_string()
    };

    OsSpecificInfo {
        os: linux_os_name(),
        gpu: read_gpu_info(),
        monitors: read_monitor_info(),
        disks,
        battery: read_battery_status(),
        domain: "N/A".to_string(),
        system_drive: "/".to_string(),
        system_dir: "/usr/bin".to_string(),
        antivirus: "N/A".to_string(),
        firewall: get_firewall_status().await,
        cpu_max_speed,
    }
}

fn read_monitor_info() -> String {
    let mut resolutions = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
        for entry in entries.flatten() {
            let status_path = entry.path().join("status");
            let Ok(status) = std::fs::read_to_string(&status_path) else {
                continue;
            };
            if status.trim() != "connected" {
                continue;
            }
            let modes_path = entry.path().join("modes");
            let Ok(modes) = std::fs::read_to_string(&modes_path) else {
                continue;
            };
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

fn get_disk_labels() -> String {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let labels: Vec<String> = disks
        .list()
        .iter()
        .map(|d| {
            let size = d.total_space() / 1024 / 1024 / 1024;
            format!("{} ({size}GB)", d.name().to_string_lossy())
        })
        .collect();
    if labels.is_empty() {
        "N/A".to_string()
    } else {
        labels.join(", ")
    }
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
