use crate::state::SharedState;
use axum::{
    Json,
    body::Bytes,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize, Serialize)]
pub struct StreamSettingsDTO {
    pub quality: Option<u8>,
    pub resolution_percentage: Option<u8>,
    pub target_fps: Option<u64>,
}

#[derive(Serialize)]
pub struct CurrentSettingsResponse {
    pub quality: u8,
    pub resolution_percentage: u8,
    pub target_fps: u64,
    pub native_width: i32,
    pub native_height: i32,
}

pub async fn get_settings_handler(
    State(state): State<SharedState>,
) -> Json<CurrentSettingsResponse> {
    let screen = state.screen.clone();
    let s = screen.settings.lock().unwrap();
    let (native_width, native_height) = screen.native_size();

    Json(CurrentSettingsResponse {
        quality: s.quality,
        resolution_percentage: s.resolution_percentage,
        target_fps: s.target_fps,
        native_width,
        native_height,
    })
}

pub async fn update_settings_handler(
    State(state): State<SharedState>,
    Json(payload): Json<StreamSettingsDTO>,
) -> Json<CurrentSettingsResponse> {
    let screen = state.screen.clone();

    screen.update_settings(
        payload.quality.unwrap_or(75),
        payload.resolution_percentage.unwrap_or(100),
    );

    if let Some(fps) = payload.target_fps {
        screen.set_target_fps(fps);
    }

    get_settings_handler(State(state)).await
}

pub async fn stop_stream_handler(State(state): State<SharedState>) -> Json<serde_json::Value> {
    state.screen.stop_capture();
    Json(json!({"status": "success"}))
}

pub async fn stream_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: SharedState) {
    let mut rx = {
        let screen = state.screen.clone();
        if let Err(err) = screen.start_capture().await {
            tracing::error!("Failed to start screen capture: {err:#}");
            return;
        }
        screen.get_frame_receiver()
    };

    loop {
        if rx.changed().await.is_err() {
            break;
        }

        // We extract the data we need and drop the 'frame' reference IMMEDIATELY
        // before we do any async work (await).
        let (jpeg_data, fps, active_window) = {
            let frame = rx.borrow_and_update();
            if frame.jpeg.is_empty() {
                continue;
            }
            // Cloning the Arc is cheap (just increments a counter)
            (
                frame.jpeg.clone(),
                frame.actual_fps,
                frame.active_window.clone(),
            )
        };
        // 'frame' is dropped here, so the lock is released.

        let meta = json!({
            "fps": fps,
            "win": active_window
        })
        .to_string();

        if socket.send(Message::Text(meta.into())).await.is_err() {
            break;
        }

        // Convert Arc<Vec<u8>> to Bytes
        let image_bytes = Bytes::from(jpeg_data.to_vec());

        if socket.send(Message::Binary(image_bytes)).await.is_err() {
            break;
        }
    }
}

pub async fn screenshot_handler(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let mut rx = {
        let screen_manager = state.screen.clone();
        if let Err(err) = screen_manager.start_capture().await {
            return Json(json!({"status": "error", "message": err.to_string()}));
        }
        screen_manager.get_frame_receiver()
    };

    if rx.changed().await.is_err() {
        return Json(json!({"status": "error", "message": "Channel closed"}));
    }

    let frame_data = rx.borrow();
    if !frame_data.jpeg.is_empty() {
        use base64::{Engine as _, engine::general_purpose};
        let b64 = general_purpose::STANDARD.encode(&**frame_data.jpeg);
        Json(json!({"status": "success", "image": b64}))
    } else {
        Json(json!({"status": "error", "message": "No frame"}))
    }
}
