#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("The Remote Control system is only supported on Windows and Linux.");

use anyhow::Result;
use socketioxide::SocketIo;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod api;
mod config;
mod realtime;
mod services;
mod state;
mod utils;

use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("remote_control=debug,tower_http=debug")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    #[cfg(target_os = "linux")]
    if std::env::var("WAYLAND_DISPLAY").is_err() {
        // SAFETY: called once in main() before any threads are spawned.
        unsafe { std::env::set_var("WAYLAND_DISPLAY", "wayland-0") };
    }

    tracing::info!("Initializing Remote Control System...");

    // 1. Load Config
    let config = config::load().await?;
    let port = config.port;

    // 2. Initialize State with Config
    let state = AppState::new(config);

    // 3. Initialize Socket.IO
    let (socket_layer, io) = SocketIo::builder().with_state(state.clone()).build_layer();

    realtime::events::register(io, state.clone());

    // 4. Create Web Router
    let app = api::router::create_router(state.clone()).layer(socket_layer);

    let host = "0.0.0.0";
    let listener = TcpListener::bind(format!("{}:{}", host, port)).await?;

    tracing::info!("Server listening on http://localhost:{}", port);

    axum::serve(listener, app).await?;

    Ok(())
}
