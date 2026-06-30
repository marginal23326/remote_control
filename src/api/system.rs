use crate::services::system::{SystemInfoDTO, get_system_info};
use crate::state::SharedState;
use axum::{Json, extract::State};

pub async fn get_system_info_handler(State(state): State<SharedState>) -> Json<SystemInfoDTO> {
    let info = get_system_info(&state).await;
    Json(info)
}

#[derive(serde::Serialize)]
pub struct ClipboardResponse {
    pub text: String,
}

#[derive(serde::Deserialize)]
pub struct ClipboardRequest {
    pub text: String,
}

pub async fn get_clipboard_handler() -> crate::utils::error::AppResult<axum::Json<ClipboardResponse>> {
    let text = tokio::task::spawn_blocking(|| -> anyhow::Result<String> {
        let mut ctx = arboard::Clipboard::new()?;
        match ctx.get_text() {
            Ok(t) => Ok(t),
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(e.into()),
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;

    Ok(axum::Json(ClipboardResponse { text }))
}

pub async fn set_clipboard_handler(
    axum::Json(payload): axum::Json<ClipboardRequest>,
) -> crate::utils::error::AppResult<axum::Json<serde_json::Value>> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut ctx = arboard::Clipboard::new()?;
        ctx.set_text(payload.text)?;
        Ok(())
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;

    Ok(axum::Json(serde_json::json!({"status": "success"})))
}
