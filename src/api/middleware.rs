use crate::{
    state::SharedState,
    utils::auth::{extract_token_from_cookie, verify_jwt},
};
use axum::{
    extract::{Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::Response,
};

pub async fn auth_middleware(
    State(state): State<SharedState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // 1. Extract Cookie Header
    let cookie_header = req.headers().get(header::COOKIE).and_then(|h| h.to_str().ok());

    let cookie_str = match cookie_header {
        Some(s) => s,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    // 2. Extract Token
    let token = match extract_token_from_cookie(cookie_str) {
        Some(t) => t,
        None => return Err(StatusCode::UNAUTHORIZED),
    };

    // 3. Verify JWT
    let is_valid = {
        let config = &state.config;
        verify_jwt(token, &config.jwt_secret)
    };

    if is_valid {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}
