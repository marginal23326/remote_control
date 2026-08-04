pub async fn try_blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(Into::into).flatten()
}

pub async fn run_blocking_or_log<T: Default + Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|e| {
        tracing::error!("Blocking task panicked: {e}");
        T::default()
    })
}
