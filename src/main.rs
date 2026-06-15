use socketioxide::SocketIo;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod api;
mod config;
mod realtime;
mod services;
mod state;
mod utils;

use crate::config::ConfigManager;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            "remote_control=debug,tower_http=debug",
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Initializing Remote Control System...");

    // 1. Load Config
    let config = ConfigManager::load().await?;
    let port = config.port;

    // 2. Initialize State with Config
    let state = Arc::new(AppState::new(config));

    // 3. Initialize Socket.IO
    let (socket_layer, io) = SocketIo::builder().with_state(state.clone()).build_layer();

    realtime::events::register(io);

    // 4. Create Web Router
    let app = api::router::create_router(state.clone()).layer(socket_layer);

    let host = "0.0.0.0";
    let listener = TcpListener::bind(format!("{}:{}", host, port)).await?;

    tracing::info!("Server listening on http://localhost:{}", port);

    axum::serve(listener, app).await?;

    Ok(())
}
