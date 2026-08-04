pub const BYTES_PER_MB: u64 = 1024 * 1024;
pub const BYTES_PER_GB: u64 = BYTES_PER_MB * 1024;

pub fn bytes_to_mb_f64(bytes: u64) -> f64 {
    bytes as f64 / BYTES_PER_MB as f64
}
