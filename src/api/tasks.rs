use axum::{
    extract::State,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::state::SharedState;
use crate::utils::error::{AppError, AppResult};

#[derive(Deserialize)]
pub struct KillPayload {
    pid: Option<u32>,
}

pub async fn kill_process_handler(
    State(state): State<SharedState>,
    Json(payload): Json<KillPayload>,
) -> AppResult<Json<Value>> {
    let pid = payload.pid.ok_or(AppError::BadRequest("PID required".to_string()))?;

    let tasks = state.tasks.lock().unwrap();
    tasks.kill_process(pid)?;
    
    Ok(Json(json!({"status": "success", "message": "Process killed"})))
}