use axum::{
    extract::State,
    Json,
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::json;
use crate::state::SharedState;

#[derive(Deserialize)]
pub struct KillPayload {
    pid: Option<u32>,
}

pub async fn kill_process_handler(
    State(state): State<SharedState>,
    Json(payload): Json<KillPayload>,
) -> impl IntoResponse {
    if let Some(pid) = payload.pid {
        let tasks = state.tasks.lock().unwrap();
        match tasks.kill_process(pid) {
            Ok(_) => Json(json!({"status": "success", "message": "Process killed"})).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"status": "error", "message": e.to_string()}))).into_response(),
        }
    } else {
        (StatusCode::BAD_REQUEST, Json(json!({"status": "error", "message": "PID required"}))).into_response()
    }
}