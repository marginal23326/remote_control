use crate::state::AppState;
use crate::utils::auth::{Claims, create_jwt, verify_password};
use crate::utils::error::success;
use crate::utils::error::{AppError, AppResult};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use cookie::{Cookie, SameSite};
use serde::Deserialize;
use serde_json::json;
use time::Duration;

const SESSION_DURATION: Duration = Duration::hours(24);

#[derive(Deserialize)]
pub struct LoginRequest {
    password: String,
}

fn auth_cookie(token: &str, max_age: Duration) -> HeaderValue {
    Cookie::build(("auth_token", token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Strict)
        .max_age(max_age)
        .to_string()
        .parse()
        .unwrap()
}

pub async fn login_handler(State(state): State<AppState>, Json(payload): Json<LoginRequest>) -> AppResult<Response> {
    let config = &state.config;

    if verify_password(&payload.password, &config.password_hash) {
        let expiration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize
            + SESSION_DURATION.whole_seconds() as usize;

        let claims = Claims { exp: expiration };

        let token = create_jwt(&claims, &config.jwt_secret)?;

        let mut headers = HeaderMap::new();
        headers.insert(header::SET_COOKIE, auth_cookie(&token, SESSION_DURATION));

        Ok((headers, success!()).into_response())
    } else {
        Err(AppError::AuthError("Invalid credentials".to_string()))
    }
}

pub async fn logout_handler() -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, auth_cookie("", Duration::ZERO));
    (headers, Json(json!({"status": "logged_out"}))).into_response()
}
