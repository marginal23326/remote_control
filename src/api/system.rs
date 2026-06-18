use crate::services::system::{SystemInfoDTO, get_system_info};
use crate::state::SharedState;
use axum::{Json, extract::State};

pub async fn get_system_info_handler(State(state): State<SharedState>) -> Json<SystemInfoDTO> {
    let info = get_system_info(&state).await;
    Json(info)
}
