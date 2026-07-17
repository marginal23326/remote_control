use crate::api::{
    auth::{login_handler, logout_handler},
    files::{
        check_access_handler, create_folder_handler, delete_handler, download_handler, get_home_handler,
        list_files_handler, rename_handler, upload_handler,
    },
    middleware::auth_middleware,
    stream::{get_screenshot_handler, get_settings_handler, stop_stream_handler, update_settings_handler},
    system::{get_clipboard_handler, get_system_info_handler, set_clipboard_handler},
    tasks::{get_process_details_handler, kill_process_handler},
};
use crate::state::SharedState;
use crate::utils::auth::is_authenticated;
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, header},
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;
use tower_http::services::ServeFile;

async fn serve_no_cache(file: &str, req: Request) -> Response {
    match ServeFile::new(file).try_call(req).await {
        Ok(res) => {
            let mut res = res.into_response();
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, no-store, must-revalidate"),
            );
            res
        }
        Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn index_handler(State(state): State<SharedState>, req: Request) -> Response {
    if is_authenticated(req.headers(), &state.config.jwt_secret) {
        serve_no_cache("static/dist/index.html", req).await
    } else {
        Redirect::to("/login").into_response()
    }
}

async fn login_page_handler(State(state): State<SharedState>, req: Request) -> Response {
    if is_authenticated(req.headers(), &state.config.jwt_secret) {
        Redirect::to("/").into_response()
    } else {
        serve_no_cache("static/dist/login.html", req).await
    }
}

pub fn create_router(state: SharedState) -> Router {
    // Serve static files (JS, CSS, assets)
    let serve_static = ServeDir::new("static");

    // 1. Define Public Routes
    let auth_routes = Router::new()
        .route("/login", post(login_handler).get(login_page_handler))
        .route("/logout", get(logout_handler));

    // 2. Define Protected API Routes
    let api_routes = Router::new()
        .route("/system", get(get_system_info_handler))
        .route(
            "/system/clipboard",
            get(get_clipboard_handler).post(set_clipboard_handler),
        )
        .route(
            "/stream/settings",
            get(get_settings_handler).post(update_settings_handler),
        )
        .route("/stream/stop", get(stop_stream_handler))
        .route("/stream/screenshot", get(get_screenshot_handler))
        .route("/files", get(list_files_handler))
        .route("/files/home", get(get_home_handler))
        .route("/files/check-access", post(check_access_handler))
        .route("/create_folder", post(create_folder_handler))
        .route("/delete", post(delete_handler))
        .route("/rename", post(rename_handler))
        .route("/upload", post(upload_handler).layer(DefaultBodyLimit::disable()))
        .route("/download", post(download_handler))
        .route("/tasks/kill", post(kill_process_handler))
        .route("/tasks/{pid}", get(get_process_details_handler))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    // Serve assets at /assets path (Vite builds with /assets/* references)
    // Vite hashes filenames, so these can be cached indefinitely
    let serve_assets = ServeDir::new("static/dist/assets");
    let assets_routes = Router::new()
        .fallback_service(serve_assets)
        .layer(middleware::map_response(|mut res: Response| async move {
            if res.status().is_success() {
                res.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=2592000, immutable"),
                );
            }
            res
        }));

    // 3. Assemble
    Router::new()
        .route("/", get(index_handler))
        .merge(auth_routes)
        .nest("/api", api_routes)
        .nest("/assets", assets_routes)
        .nest_service("/static", serve_static)
        .layer(CompressionLayer::new())
        .with_state(state)
}
