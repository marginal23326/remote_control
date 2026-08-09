use crate::state::AppState;
use crate::utils::blocking::run_blocking;
use crate::utils::error::{AppError, AppResult, success};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct KillPayload {
    pid: Option<u32>,
}

pub async fn kill_process_handler(
    State(state): State<AppState>,
    Json(payload): Json<KillPayload>,
) -> AppResult<Json<Value>> {
    let pid = payload.pid.ok_or(AppError::BadRequest("PID required".to_string()))?;

    let tasks = &state.tasks;
    tasks.kill_process(pid)?;

    Ok(success!("message": "Process killed"))
}

pub async fn get_process_details_handler(
    State(state): State<AppState>,
    Path(pid): Path<u32>,
) -> AppResult<Json<Value>> {
    let details = run_blocking(move || {
        state
            .tasks
            .get_process_details(pid)
            .map_err(|_| AppError::NotFound(format!("Process with PID {pid} not found")))
    })
    .await?;

    Ok(success!("data": details))
}
