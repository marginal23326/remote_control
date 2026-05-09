use crate::services::system::{SystemInfoDTO, get_system_info};
use crate::state::SharedState;
use axum::{Json, extract::State};

pub async fn get_system_info_handler(State(state): State<SharedState>) -> Json<SystemInfoDTO> {
    // We now await the result because it performs async network calls (WAN IP)
    let info = get_system_info(&state.sys, &state.networks).await;
    Json(info)
}
