use crate::state::SharedState;
use crate::utils::auth::{Claims, create_jwt};
use crate::utils::error::{AppError, AppResult};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

fn verify_password(password: &str, stored: &str) -> bool {
    let Some((salt_b64, hash_b64)) = stored.split_once(':') else {
        return false;
    };
    let Ok(salt) = BASE64.decode(salt_b64) else {
        return false;
    };
    let Ok(expected) = BASE64.decode(hash_b64) else {
        return false;
    };
    let actual = Sha256::new()
        .chain_update(&salt)
        .chain_update(password.as_bytes())
        .finalize();
    actual.as_slice() == expected.as_slice()
}

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login_handler(State(state): State<SharedState>, Json(payload): Json<LoginRequest>) -> AppResult<Response> {
    let config = &state.config;

    let password_valid = verify_password(&payload.password, &config.password_hash);
    let username_valid = payload.username == config.username;

    if username_valid && password_valid {
        let expiration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize
            + (60 * 60 * 24); // 24 hours

        let claims = Claims {
            sub: payload.username.clone(),
            exp: expiration,
        };

        let token = create_jwt(&claims, &config.jwt_secret)?;

        let mut headers = HeaderMap::new();
        let cookie_value = format!("auth_token={}; Path=/; HttpOnly; SameSite=Strict", token);
        headers.insert(header::SET_COOKIE, cookie_value.parse().unwrap());

        Ok((headers, Json(json!({"status": "success"}))).into_response())
    } else {
        Err(AppError::AuthError("Invalid credentials".to_string()))
    }
}

pub async fn logout_handler() -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        "auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
            .parse()
            .unwrap(),
    );
    (headers, Json(json!({"status": "logged_out"}))).into_response()
}
