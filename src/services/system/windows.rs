use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory, IDXGIFactory};
use windows::Win32::System::Com::{
    CLSCTX_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CoUninitialize,
    EOAC_NONE, RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};
use windows::Win32::System::Variant::{VARIANT, VT_BSTR, VT_I4, VT_I8, VT_UI4, VT_UI8};
use windows::Win32::System::Wmi::{
    IWbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
use windows::core::{BSTR, GUID, HSTRING, PCWSTR};

use super::OsSpecificInfo;

const CLSID_WBEM_LOCATOR: GUID = GUID::from_u128(0x4590f811_1d3a_11d0_891f_00aa004b2e24);

pub(crate) async fn get_os_specific_info(_cpu_frequency: u64) -> OsSpecificInfo {
    tokio::task::spawn_blocking(move || {
        let gpu_info = get_gpu_info();
        let disk_info = get_disk_info();
        let antivirus_info = get_antivirus_info();
        let cpu_max_speed = get_cpu_max_speed();
        let os_edition = get_windows_product_name().unwrap_or_else(|| "Windows".to_string());
        let (screen_w, screen_h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        let battery_status = get_battery_status();
        let domain = std::env::var("USERDOMAIN")
            .or_else(|_| std::env::var("userdomain"))
            .unwrap_or_else(|_| "WORKGROUP".to_string());

        OsSpecificInfo {
            os: os_edition,
            gpu: gpu_info,
            monitors: format!("Display ({}x{})", screen_w, screen_h),
            disks: disk_info,
            battery: battery_status,
            domain,
            system_drive: "C:".to_string(),
            antivirus: antivirus_info,
            firewall: get_firewall_status(),
            cpu_max_speed,
        }
    })
    .await
    .unwrap()
}

fn get_gpu_info() -> String {
    unsafe {
        let factory: IDXGIFactory = match CreateDXGIFactory() {
            Ok(f) => f,
            Err(_) => return "N/A".to_string(),
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

        if gpus.is_empty() {
            "N/A".to_string()
        } else {
            gpus.join(", ")
        }
    }
}

fn get_disk_info() -> String {
    let rows = wmi_query(
        "root\\cimv2",
        "SELECT Model, Size FROM Win32_DiskDrive",
        &["Model", "Size"],
    );

    let mut disks = Vec::new();
    for row in &rows {
        let model = &row[0];
        let size_str = &row[1];

        if let Ok(bytes) = size_str.parse::<u64>() {
            let gb = bytes / 1024 / 1024 / 1024;
            disks.push(format!("{} ({}GB)", model, gb));
        } else {
            disks.push(model.clone());
        }
    }

    if disks.is_empty() {
        "N/A".to_string()
    } else {
        disks.join(", ")
    }
}

fn get_cpu_max_speed() -> String {
    if let Some(mhz) = read_reg_dword(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "~MHz") {
        return format!("{:.2} GHz", mhz as f64 / 1000.0);
    }
    "N/A".to_string()
}

fn get_antivirus_info() -> String {
    let rows = wmi_query(
        "root\\SecurityCenter2",
        "SELECT displayName FROM AntiVirusProduct",
        &["displayName"],
    );

    let mut items = Vec::new();
    for row in &rows {
        let name = &row[0];
        if !name.is_empty() && !items.contains(name) {
            items.push(name.clone());
        }
    }

    if items.is_empty() {
        "N/A".to_string()
    } else {
        items.join(", ")
    }
}

struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

fn wmi_query(namespace: &str, query: &str, properties: &[&str]) -> Vec<Vec<String>> {
    unsafe {
        let _guard = if CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() {
            Some(ComGuard)
        } else {
            return Vec::new();
        };

        let locator: IWbemLocator = match CoCreateInstance(&CLSID_WBEM_LOCATOR, None, CLSCTX_SERVER) {
            Ok(l) => l,
            Err(_) => return Vec::new(),
        };

        let ns = BSTR::from(namespace);
        let empty = BSTR::new();
        let services = match locator.ConnectServer(&ns, &empty, &empty, &empty, 0, &empty, None) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let _ = CoSetProxyBlanket(
            &services,
            10,
            0,
            None,
            RPC_C_AUTHN_LEVEL_DEFAULT,
            RPC_C_IMP_LEVEL_IMPERSONATE,
            None,
            EOAC_NONE,
        );

        let wql = BSTR::from("WQL");
        let wql_query = BSTR::from(query);
        let flags = WBEM_GENERIC_FLAG_TYPE(WBEM_FLAG_FORWARD_ONLY.0 | WBEM_FLAG_RETURN_IMMEDIATELY.0);
        let results = match services.ExecQuery(&wql, &wql_query, flags, None) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        let mut rows = Vec::new();
        let prop_names: Vec<HSTRING> = properties.iter().map(|p| HSTRING::from(*p)).collect();

        loop {
            let mut objs = [None; 1];
            let mut returned: u32 = 0;
            let hr = results.Next(1000, &mut objs, &mut returned);

            if hr.is_err() || returned == 0 {
                break;
            }

            if let Some(obj) = &objs[0] {
                let mut row = Vec::with_capacity(properties.len());
                for prop_name in &prop_names {
                    let mut variant = VARIANT::default();
                    let value = obj
                        .Get(PCWSTR(prop_name.as_ptr()), 0, &mut variant, None, None)
                        .ok()
                        .and_then(|()| variant_to_string(&variant))
                        .unwrap_or_default();
                    row.push(value);
                }
                rows.push(row);
            }
        }

        rows
    }
}

// VARIANT::drop calls VariantClear automatically.
unsafe fn variant_to_string(variant: &VARIANT) -> Option<String> {
    unsafe {
        let vt = variant.vt().0;
        match vt {
            t if t == VT_BSTR.0 => Some(variant.Anonymous.Anonymous.Anonymous.bstrVal.to_string()),
            t if t == VT_I4.0 => Some(variant.Anonymous.Anonymous.Anonymous.lVal.to_string()),
            t if t == VT_UI4.0 => Some(variant.Anonymous.Anonymous.Anonymous.ulVal.to_string()),
            t if t == VT_I8.0 => Some(variant.Anonymous.Anonymous.Anonymous.llVal.to_string()),
            t if t == VT_UI8.0 => Some(variant.Anonymous.Anonymous.Anonymous.ullVal.to_string()),
            _ => None,
        }
    }
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
