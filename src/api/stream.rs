use crate::state::SharedState;
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize, Serialize)]
pub struct StreamSettingsDTO {
    pub bitrate: Option<u32>,
    pub resolution_percentage: Option<u8>,
    pub target_fps: Option<u64>,
}

#[derive(Serialize)]
pub struct CurrentSettingsResponse {
    pub bitrate: u32,
    pub resolution_percentage: u8,
    pub target_fps: u64,
    pub max_fps: u64,
    pub native_width: i32,
    pub native_height: i32,
}

pub async fn get_settings_handler(
    State(state): State<SharedState>,
) -> Json<CurrentSettingsResponse> {
    let screen = state.screen.clone();
    let s = screen.settings.lock().unwrap();
    let (native_width, native_height) = *screen.native_size.lock().unwrap();

    Json(CurrentSettingsResponse {
        bitrate: s.bitrate,
        resolution_percentage: s.resolution_percentage,
        target_fps: s.target_fps,
        max_fps: s.max_fps,
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
        payload.bitrate.unwrap_or(5000),
        payload.resolution_percentage.unwrap_or(100),
    );

    if let Some(fps) = payload.target_fps {
        screen.set_target_fps(fps);
    }

    get_settings_handler(State(state)).await
}

pub async fn stop_stream_handler(State(state): State<SharedState>) -> Json<serde_json::Value> {
    state.screen.stop_stream();
    Json(json!({"status": "success"}))
}
