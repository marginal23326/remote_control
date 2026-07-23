use crate::state::AppState;
use crate::utils::auth::{Claims, create_jwt, verify_password};
use crate::utils::error::success;
use crate::utils::error::{AppError, AppResult};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use cookie::{Cookie, SameSite};
use serde::Deserialize;
use serde_json::json;
use time::Duration;

#[derive(Deserialize)]
pub struct LoginRequest {
    password: String,
}

pub async fn login_handler(State(state): State<AppState>, Json(payload): Json<LoginRequest>) -> AppResult<Response> {
    let config = &state.config;

    if verify_password(&payload.password, &config.password_hash) {
        let expiration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize
            + (60 * 60 * 24); // 24 hours

        let claims = Claims { exp: expiration };

        let token = create_jwt(&claims, &config.jwt_secret)?;

        let mut headers = HeaderMap::new();
        let cookie = Cookie::build(("auth_token", token))
            .path("/")
            .http_only(true)
            .same_site(SameSite::Strict)
            .max_age(Duration::hours(24));
        headers.insert(header::SET_COOKIE, cookie.to_string().parse().unwrap());

        Ok((headers, success!()).into_response())
    } else {
        Err(AppError::AuthError("Invalid credentials".to_string()))
    }
}

pub async fn logout_handler() -> Response {
    let mut headers = HeaderMap::new();
    let cookie = Cookie::build(("auth_token", "")).path("/").max_age(Duration::ZERO);
    headers.insert(header::SET_COOKIE, cookie.to_string().parse().unwrap());
    (headers, Json(json!({"status": "logged_out"}))).into_response()
}
