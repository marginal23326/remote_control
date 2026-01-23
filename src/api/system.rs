use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::services::system::{get_system_info, SystemInfoDTO};

pub async fn get_system_info_handler(
    State(state): State<SharedState>
) -> Json<SystemInfoDTO> {
    // We now await the result because it performs async network calls (WAN IP)
    let info = get_system_info(&state.sys, &state.networks).await;
    Json(info)
}