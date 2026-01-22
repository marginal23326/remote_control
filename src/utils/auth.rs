use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // Subject (username)
    pub exp: usize,  // Expiration time
}

pub fn extract_token_from_cookie(cookie_str: &str) -> Option<&str> {
    cookie_str
        .split(';')
        .find_map(|s| {
            let s = s.trim();
            if s.starts_with("auth_token=") {
                Some(s.trim_start_matches("auth_token="))
            } else {
                None
            }
        })
}

pub fn verify_jwt(token: &str, secret: &str) -> bool {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    ).is_ok()
}