use axum::{
    routing::{get, post},
    middleware,
    Router,
    response::{Redirect, IntoResponse, Response},
    extract::{State, Request},
    http::header,
};
use tower_http::services::ServeDir;
use tower_http::services::ServeFile;
use crate::state::SharedState;
use crate::utils::auth::{extract_token_from_cookie, verify_jwt};
use crate::api::{
    system::get_system_info_handler,
    stream::{stream_handler, get_settings_handler, update_settings_handler, stop_stream_handler, screenshot_handler},
    files::{list_files_handler, create_folder_handler, delete_handler, rename_handler, upload_handler, download_handler},
    auth::{login_handler, logout_handler},
    tasks::kill_process_handler,
    middleware::auth_middleware,
};

// New handler for the root path "/"
async fn index_handler(State(state): State<SharedState>, req: Request) -> Response {
    let cookie_header = req.headers().get(header::COOKIE)
        .and_then(|h| h.to_str().ok());

    let is_authed = if let Some(cookie_str) = cookie_header {
        if let Some(token) = extract_token_from_cookie(cookie_str) {
            let config = state.config.lock().unwrap();
            verify_jwt(token, &config.jwt_secret)
        } else {
            false
        }
    } else {
        false
    };

    if is_authed {
        ServeFile::new("templates/index.html").try_call(req).await.unwrap().into_response()
    } else {
        Redirect::to("/login").into_response()
    }
}

pub fn create_router(state: SharedState) -> Router {
    let serve_static = ServeDir::new("static");

    // 1. Define Public Routes
    let auth_routes = Router::new()
        .route("/login", 
            post(login_handler)
            .get_service(ServeFile::new("templates/login.html"))
        )
        .route("/logout", get(logout_handler));

    // 2. Define Protected API Routes
    let api_routes = Router::new()
        .route("/system", get(get_system_info_handler))
        .route("/stream", get(stream_handler))
        .route("/stream/settings", get(get_settings_handler).post(update_settings_handler))
        .route("/stream/stop", get(stop_stream_handler))
        .route("/screenshot", get(screenshot_handler))
        .route("/files", get(list_files_handler))
        .route("/create_folder", post(create_folder_handler))
        .route("/delete", post(delete_handler))
        .route("/rename", post(rename_handler))
        .route("/upload", post(upload_handler))
        .route("/download", get(download_handler))
        .route("/tasks/kill", post(kill_process_handler))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    // 3. Assemble
    Router::new()
        .route("/", get(index_handler)) 
        .merge(auth_routes)
        .nest("/api", api_routes)
        .nest_service("/static", serve_static)
        .with_state(state)
}