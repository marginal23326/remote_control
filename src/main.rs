use std::sync::Arc;
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use socketioxide::SocketIo;

mod api;
mod realtime;
mod services;
mod utils;
mod config;
mod state;

use crate::state::AppState;
use crate::config::ConfigManager;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("remote_control=debug,tower_http=debug"))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Initializing Remote Control System...");

    // 1. Load Config
    let config = ConfigManager::load().await?;
    let port = config.port;

    // 2. Initialize State with Config
    let state = Arc::new(AppState::new(config));

    // 3. Initialize Socket.IO
    let (socket_layer, io) = SocketIo::builder()
        .with_state(state.clone()) 
        .build_layer();

    realtime::events::register(io);

    // 4. Create Web Router
    let app = api::router::create_router(state.clone())
        .layer(socket_layer);

    let host = "0.0.0.0";
    let listener = TcpListener::bind(format!("{}:{}", host, port)).await?;
    
    tracing::info!("Server listening on http://{}:{}", host, port);
    
    axum::serve(listener, app).await?;

    Ok(())
}