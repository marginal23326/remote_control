use crate::services::system::{SystemInfoDTO, get_system_info};
use crate::state::AppState;
use crate::utils::blocking::run_blocking;
use crate::utils::error::success;
use axum::{Json, extract::State};

pub async fn get_system_info_handler(State(state): State<AppState>) -> Json<SystemInfoDTO> {
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

fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> anyhow::Result<T>) -> anyhow::Result<T> {
    let mut ctx = arboard::Clipboard::new()?;
    f(&mut ctx)
}

pub async fn get_clipboard_handler() -> crate::utils::error::AppResult<Json<ClipboardResponse>> {
    let text = run_blocking(|| -> anyhow::Result<String> {
        with_clipboard(|ctx| match ctx.get_text() {
            Ok(t) => Ok(t),
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(e.into()),
        })
    })
    .await?;

    Ok(Json(ClipboardResponse { text }))
}

pub async fn set_clipboard_handler(
    Json(payload): Json<ClipboardRequest>,
) -> crate::utils::error::AppResult<Json<serde_json::Value>> {
    run_blocking(move || -> anyhow::Result<()> { with_clipboard(|ctx| Ok(ctx.set_text(payload.text)?)) }).await?;

    Ok(success!())
}
