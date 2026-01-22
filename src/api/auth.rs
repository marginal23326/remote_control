use axum::{
    extract::State,
    http::{StatusCode, HeaderMap, header},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use bcrypt::verify;
use jsonwebtoken::{encode, EncodingKey, Header};
use crate::state::SharedState;
use crate::utils::auth::Claims;

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

pub async fn login_handler(
    State(state): State<SharedState>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let config = state.config.lock().unwrap();

    let password_valid = verify(&payload.password, &config.password_hash).unwrap_or(false);
    let username_valid = payload.username == config.username;

    if username_valid && password_valid {
        // 3. Generate JWT
        let expiration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize + (60 * 60 * 24); // 24 hours

        let claims = Claims {
            sub: payload.username.clone(),
            exp: expiration,
        };

        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
        ).unwrap();

        // 4. Set Cookie
        let mut headers = HeaderMap::new();
        let cookie_value = format!("auth_token={}; Path=/; HttpOnly; SameSite=Strict", token);
        headers.insert(header::SET_COOKIE, cookie_value.parse().unwrap());

        (headers, Json(json!({"status": "success", "token": token}))).into_response()
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid credentials"}))).into_response()
    }
}

pub async fn logout_handler() -> Response {
    let mut headers = HeaderMap::new();
    // Overwrite the cookie with an expired one
    headers.insert(header::SET_COOKIE, "auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT".parse().unwrap());
    
    (headers, Json(json!({"status": "logged_out"}))).into_response()
}