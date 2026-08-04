use std::collections::HashMap;

// sysinfo's global_cpu_usage() is unreliable on Windows, so we sample directly.
pub(crate) struct CpuTracker {
    prev_total: u64,
    prev_busy: u64,
}

impl CpuTracker {
    pub(crate) fn new() -> Self {
        Self {
            prev_total: 0,
            prev_busy: 0,
        }
    }

    pub(crate) fn sample(&mut self) -> f32 {
        use std::mem;
        use windows::Win32::System::Threading::GetSystemTimes;

        unsafe {
            let (mut idle, mut kernel, mut user) = (mem::zeroed(), mem::zeroed(), mem::zeroed());
            let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));

            let idle = ((idle.dwHighDateTime as u64) << 32) | (idle.dwLowDateTime as u64);
            let kernel = ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
            let user = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
            let total = kernel + user;
            let busy = total - idle;

            let result = if self.prev_total == 0 {
                0.0
            } else {
                let dt_total = total.saturating_sub(self.prev_total);
                let dt_busy = busy.saturating_sub(self.prev_busy);
                if dt_total == 0 {
                    0.0
                } else {
                    (dt_busy as f64 / dt_total as f64 * 100.0) as f32
                }
            };

            self.prev_total = total;
            self.prev_busy = busy;
            result
        }
    }
}

pub(crate) unsafe fn get_all_private_working_sets() -> HashMap<u32, u64> {
    use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};

    let mut required_len: u32 = 0;
    unsafe {
        let _ = NtQuerySystemInformation(SystemProcessInformation, std::ptr::null_mut(), 0, &mut required_len);
    }

    let alloc_size = (required_len as usize) + 4096;
    let mut buffer: Vec<u8> = vec![0u8; alloc_size];

    let status = unsafe {
        NtQuerySystemInformation(
            SystemProcessInformation,
            buffer.as_mut_ptr() as *mut _,
            buffer.len() as u32,
            &mut required_len,
        )
    };

    if !status.is_ok() {
        return HashMap::new();
    }

    // Each entry is a SYSTEM_PROCESS_INFORMATION (x64 layout): NextEntryOffset @0x00, WorkingSetPrivateSize @0x08, UniqueProcessId @0x50.
    let mut map = HashMap::new();
    let mut offset = 0usize;
    loop {
        if offset + 0x58 > buffer.len() {
            break;
        }
        let next_offset = u32::from_ne_bytes(buffer[offset..offset + 4].try_into().unwrap()) as usize;
        let pid = usize::from_ne_bytes(buffer[offset + 0x50..offset + 0x58].try_into().unwrap()) as u32;
        let pws = i64::from_ne_bytes(buffer[offset + 0x08..offset + 0x10].try_into().unwrap());
        if pws > 0 {
            map.insert(pid, pws as u64);
        }
        if next_offset == 0 {
            break;
        }
        offset += next_offset;
    }
    map
}
