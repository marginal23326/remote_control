use sysinfo::System;
use tokio::process::Command;

use super::OsSpecificInfo;

pub(crate) async fn get_os_specific_info(cpu_frequency: u64) -> OsSpecificInfo {
    let (disks, os, gpu, monitors, battery) = tokio::task::spawn_blocking(move || {
        (
            get_disk_labels(),
            linux_os_name(),
            read_gpu_info(),
            read_monitor_info(),
            read_battery_status(),
        )
    })
    .await
    .unwrap();

    let firewall = get_firewall_status().await;

    OsSpecificInfo {
        os,
        gpu,
        monitors,
        disks,
        battery,
        domain: None,
        system_drive: "/".to_string(),
        antivirus: Vec::new(),
        firewall,
        cpu_max_speed_mhz: (cpu_frequency > 0).then_some(cpu_frequency as u32),
    }
}

fn read_monitor_info() -> Vec<String> {
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
    resolutions
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

fn get_disk_labels() -> Vec<String> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .map(|d| {
            let size = d.total_space() / 1024 / 1024 / 1024;
            format!("{} ({size}GB)", d.name().to_string_lossy())
        })
        .collect()
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

        let capacity = std::fs::read_to_string(path.join("capacity")).unwrap_or_else(|_| "Unknown".to_string());
        let status = std::fs::read_to_string(path.join("status")).unwrap_or_else(|_| "Battery".to_string());
        return format!("{} ({}% remaining)", status.trim(), capacity.trim());
    }

    "No battery detected".to_string()
}

fn read_gpu_info() -> Vec<String> {
    let Ok(output) = std::process::Command::new("sh")
        .arg("-c")
        .arg("command -v lspci >/dev/null 2>&1 && lspci | grep -Ei 'vga|3d|display' || true")
        .output()
    else {
        return Vec::new();
    };

    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .filter_map(|line| line.split_once(':').map(|(_, rest)| rest.trim().to_string()))
        .filter(|line| !line.is_empty())
        .collect()
}

async fn get_firewall_status() -> String {
    match Command::new("firewall-cmd").arg("--state").output().await {
        Ok(output) if output.status.success() => {
            let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if state.is_empty() { "Unknown".to_string() } else { state }
        }
        Ok(_) => "Disabled".to_string(),
        Err(_) => "Unknown".to_string(),
    }
}
