use axum::http::{HeaderMap, header};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub fn is_authenticated(headers: &HeaderMap, secret: &str) -> bool {
    headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(extract_token_from_cookie)
        .map(|token| verify_jwt(token, secret))
        .unwrap_or(false)
}

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub exp: usize,
}

pub fn extract_token_from_cookie(cookie_str: &str) -> Option<&str> {
    cookie_str.split(';').find_map(|s| s.trim().strip_prefix("auth_token="))
}

// Hand-rolled to avoid pulling in `jsonwebtoken`.
pub fn create_jwt(claims: &Claims, secret: &str) -> anyhow::Result<String> {
    let header = r#"{"alg":"HS256","typ":"JWT"}"#;
    let header_b64 = URL_SAFE_NO_PAD.encode(header);
    let payload = serde_json::to_string(claims)?;
    let payload_b64 = URL_SAFE_NO_PAD.encode(&payload);
    let signing_input = format!("{}.{}", header_b64, payload_b64);

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    Ok(format!("{}.{}", signing_input, signature))
}

pub fn verify_jwt(token: &str, secret: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return false;
    }

    let signing_input = format!("{}.{}", parts[0], parts[1]);

    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(signing_input.as_bytes());

    let signature_bytes = match URL_SAFE_NO_PAD.decode(parts[2]) {
        Ok(b) => b,
        Err(_) => return false,
    };

    if mac.verify_slice(&signature_bytes).is_err() {
        return false;
    }

    let payload_bytes = match URL_SAFE_NO_PAD.decode(parts[1]) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let claims: Claims = match serde_json::from_slice(&payload_bytes) {
        Ok(c) => c,
        Err(_) => return false,
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as usize;

    now < claims.exp
}
