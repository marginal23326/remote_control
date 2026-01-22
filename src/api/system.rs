use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::services::system::{get_system_info, SystemInfoDTO};

pub async fn get_system_info_handler(
    State(state): State<SharedState>
) -> Json<SystemInfoDTO> {
    // Call the service logic
    let info = get_system_info(&state.sys, &state.networks);
    Json(info)
}