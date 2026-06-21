use crate::state::SharedState;
use crate::utils::error::{AppError, AppResult};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct KillPayload {
    pid: Option<u32>,
}

pub async fn kill_process_handler(
    State(state): State<SharedState>,
    Json(payload): Json<KillPayload>,
) -> AppResult<Json<Value>> {
    let pid = payload.pid.ok_or(AppError::BadRequest("PID required".to_string()))?;

    let tasks = &state.tasks;
    tasks.kill_process(pid)?;

    Ok(Json(json!({"status": "success", "message": "Process killed"})))
}

pub async fn get_process_details_handler(
    State(state): State<SharedState>,
    Path(pid): Path<u32>,
) -> AppResult<Json<Value>> {
    let details = tokio::task::spawn_blocking(move || state.tasks.get_process_details(pid))
        .await
        .unwrap()?;

    Ok(Json(json!({ "status": "success", "data": details })))
}
