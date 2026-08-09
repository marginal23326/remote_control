use crate::utils::error::{AppError, AppResult};

pub async fn run<T, E>(f: impl FnOnce() -> Result<T, E> + Send + 'static) -> Result<T, E>
where
    T: Send + 'static,
    E: From<tokio::task::JoinError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => Err(e.into()),
    }
}

pub async fn run_or_log_default<T: Default + Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|e| {
        tracing::error!("Blocking task panicked: {e}");
        T::default()
    })
}

pub async fn run_blocking<T, E>(f: impl FnOnce() -> Result<T, E> + Send + 'static) -> AppResult<T>
where
    T: Send + 'static,
    E: Into<AppError> + Send + 'static,
{
    run(move || f().map_err(Into::into)).await
}
