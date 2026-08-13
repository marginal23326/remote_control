use serde::Deserialize;
use tokio::process::Command;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory, IDXGIFactory};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
use windows::core::{HSTRING, PCWSTR};
use wmi::{WMIConnection, WMIResult};

use super::{OsSpecificInfo, PowerAction};

const SYSTEM_DRIVE: &str = "C:";

pub(crate) async fn get_os_specific_info(_cpu_frequency: u64) -> OsSpecificInfo {
    tokio::task::spawn_blocking(move || {
        let gpu_info = get_gpu_info();
        let disk_info = get_disk_info();
        let disks_snapshot = sysinfo::Disks::new_with_refreshed_list();
        let (disk_total_gb, disk_used_gb, disk_free_gb) =
            super::disk_usage_from(&disks_snapshot, |mount| mount.starts_with(SYSTEM_DRIVE));
        let antivirus_info = get_antivirus_info();
        let cpu_max_speed_mhz = get_cpu_max_speed();
        let os_edition = get_windows_product_name().unwrap_or_else(|| "Windows".to_string());
        let (screen_w, screen_h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        let battery_status = get_battery_status();
        let domain = std::env::var("USERDOMAIN")
            .or_else(|_| std::env::var("userdomain"))
            .unwrap_or_else(|_| "WORKGROUP".to_string());

        OsSpecificInfo {
            os: os_edition,
            gpu: gpu_info,
            monitors: vec![format!("Display ({}x{})", screen_w, screen_h)],
            disks: disk_info,
            battery: battery_status,
            domain: Some(domain),
            system_drive: SYSTEM_DRIVE.to_string(),
            antivirus: antivirus_info,
            firewall: get_firewall_status(),
            cpu_max_speed_mhz,
            disk_total_gb,
            disk_used_gb,
            disk_free_gb,
        }
    })
    .await
    .unwrap()
}

pub(crate) async fn execute_power_action(action: PowerAction) -> anyhow::Result<()> {
    let (cmd, args): (&str, &[&str]) = match action {
        PowerAction::Shutdown => ("shutdown", &["/s", "/t", "0"]),
        PowerAction::Restart => ("shutdown", &["/r", "/t", "0"]),
        PowerAction::Sleep => ("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"]),
        PowerAction::Lock => ("rundll32.exe", &["user32.dll,LockWorkStation"]),
    };

    Command::new(cmd).args(args).spawn()?;
    Ok(())
}

fn get_gpu_info() -> Vec<String> {
    unsafe {
        let factory: IDXGIFactory = match CreateDXGIFactory() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };

        let mut gpus = Vec::new();
        let mut adapter_index = 0;

        while let Ok(adapter) = factory.EnumAdapters(adapter_index) {
            if let Ok(desc) = adapter.GetDesc() {
                if desc.VendorId == 0x1414 {
                    adapter_index += 1;
                    continue;
                }
                let name = String::from_utf16_lossy(&desc.Description);
                let clean_name = name.trim_matches('\0').trim().to_string();
                if !clean_name.is_empty() {
                    gpus.push(clean_name);
                }
            }
            adapter_index += 1;
        }

        gpus
    }
}

#[derive(Deserialize)]
struct DiskDriveRow {
    #[serde(rename = "Model")]
    model: String,
    #[serde(rename = "Size")]
    size: Option<u64>,
}

fn get_disk_info() -> Vec<String> {
    query_wmi::<DiskDriveRow>(None, "SELECT Model, Size FROM Win32_DiskDrive")
        .unwrap_or_default()
        .into_iter()
        .map(|DiskDriveRow { model, size }| match size {
            Some(bytes) => super::format_disk_label(&model, bytes),
            None => model,
        })
        .collect()
}

fn get_cpu_max_speed() -> Option<u32> {
    read_reg_dword(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "~MHz")
}

#[derive(Deserialize)]
struct AntivirusRow {
    #[serde(rename = "displayName")]
    display_name: String,
}

fn get_antivirus_info() -> Vec<String> {
    let mut items = Vec::new();
    for row in query_wmi::<AntivirusRow>(
        Some(r"ROOT\SecurityCenter2"),
        "SELECT displayName FROM AntiVirusProduct",
    )
    .unwrap_or_default()
    {
        if !row.display_name.is_empty() && !items.contains(&row.display_name) {
            items.push(row.display_name);
        }
    }
    items
}

fn query_wmi<T: serde::de::DeserializeOwned>(namespace: Option<&str>, query: &str) -> WMIResult<Vec<T>> {
    let con = match namespace {
        Some(ns) => WMIConnection::with_namespace_path(ns)?,
        None => WMIConnection::new()?,
    };
    con.raw_query(query)
}

fn get_firewall_status() -> String {
    let profiles = [
        r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallDomainProfile",
        r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallPublicProfile",
        r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallStandardProfile",
    ];

    for profile in &profiles {
        if let Some(enabled) = read_reg_dword(profile, "EnableFirewall")
            && enabled == 1
        {
            return "Enabled".to_string();
        }
    }

    "Disabled".to_string()
}

fn read_reg_sz(subkey: &str, value: &str) -> Option<String> {
    unsafe {
        let subkey = HSTRING::from(subkey);
        let value = HSTRING::from(value);
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
            let u16_count = (size as usize / 2).min(buffer.len());
            let slice = &buffer[..u16_count];
            let len = slice.iter().position(|&c| c == 0).unwrap_or(u16_count);
            Some(String::from_utf16_lossy(&slice[..len]))
        } else {
            None
        }
    }
}

fn read_reg_dword(subkey: &str, value: &str) -> Option<u32> {
    unsafe {
        let subkey = HSTRING::from(subkey);
        let value = HSTRING::from(value);
        let mut data: u32 = 0;
        let mut size = core::mem::size_of::<u32>() as u32;

        let result = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        );

        if result.is_ok() { Some(data) } else { None }
    }
}

fn get_windows_product_name() -> Option<String> {
    let product_name = read_reg_sz("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "ProductName")?;
    let current_build = read_reg_sz("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "CurrentBuild")
        .and_then(|s| s.parse::<u32>().ok());

    let os_name = match current_build {
        Some(build) if build >= 22000 => product_name.replace("Windows 10", "Windows 11"),
        _ => product_name,
    };

    Some(os_name)
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
