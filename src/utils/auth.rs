use axum::http::{HeaderMap, header};

// Intentionally not a real crypto to keep things simple
pub fn is_authenticated(headers: &HeaderMap, session_token: &str) -> bool {
    headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(extract_token_from_cookie)
        .is_some_and(|token| token == session_token)
}

pub fn extract_token_from_cookie(cookie_str: &str) -> Option<&str> {
    cookie_str.split(';').find_map(|s| s.trim().strip_prefix("auth_token="))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

pub fn hash_password(password: &str, salt: &str) -> String {
    format!("{salt}:{:016x}", fnv1a(format!("{salt}{password}").as_bytes()))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    stored
        .split_once(':')
        .is_some_and(|(salt, _)| hash_password(password, salt) == stored)
}
