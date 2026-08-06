use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Authentication failed: {0}")]
    AuthError(String),

    #[error("Internal Server Error: {0}")]
    InternalError(#[from] anyhow::Error),

    #[error("Bad Request: {0}")]
    BadRequest(String),

    #[error("Not Found: {0}")]
    NotFound(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::InternalError(anyhow::anyhow!("Task join error: {e}"))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message) = match &self {
            AppError::AuthError(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::InternalError(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
        };

        tracing::error!(?status, "{}", error_message);

        let body = Json(json!({
            "status": "error",
            "message": error_message,
        }));

        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

macro_rules! success {
    () => {
        axum::Json(serde_json::json!({"status": "success"}))
    };
    ($($key:literal : $value:expr),* $(,)?) => {
        axum::Json(serde_json::json!({
            "status": "success",
            $($key : $value),*
        }))
    };
}
pub(crate) use success;

pub async fn run_blocking<T, E>(f: impl FnOnce() -> Result<T, E> + Send + 'static) -> AppResult<T>
where
    T: Send + 'static,
    E: Into<AppError> + Send + 'static,
{
    crate::utils::blocking::run(move || f().map_err(Into::into)).await
}
