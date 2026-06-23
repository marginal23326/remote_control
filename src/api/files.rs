use crate::state::SharedState;
use crate::utils::error::{AppError, AppResult};
use anyhow::anyhow;
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Query, State},
    http::{HeaderMap, Uri, header},
    response::{IntoResponse, Response},
};
use futures_util::Stream;
use mime_guess::from_path;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

// --- DATA STRUCTURES ---

#[derive(Deserialize)]
pub struct ListQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPayload {
    paths: Option<Vec<String>>,
    parent_path: Option<String>,
    folder_name: Option<String>,
    old_path: Option<String>,
    new_name: Option<String>,
}

pub struct DeleteOnDropStream<S> {
    pub inner: S,
    pub path: PathBuf,
}

impl<S: Stream + Unpin> Stream for DeleteOnDropStream<S> {
    type Item = S::Item;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

impl<S> Drop for DeleteOnDropStream<S> {
    fn drop(&mut self) {
        let path = self.path.clone();
        // Spawn a background task to delete the file
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Err(e) = tokio::fs::remove_file(&path).await {
                tracing::error!("Failed to delete temp file {:?}: {}", path, e);
            }
        });
    }
}

fn find_common_parent(paths: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    if paths.is_empty() {
        return None;
    }
    let mut common = paths[0].parent()?.to_path_buf();
    for path in paths.iter().skip(1) {
        let parent = path.parent()?;
        let mut new_common = std::path::PathBuf::new();
        for (c, p) in common.components().zip(parent.components()) {
            if c == p {
                new_common.push(c);
            } else {
                break;
            }
        }
        common = new_common;
    }
    if common.as_os_str().is_empty() {
        None
    } else {
        Some(common)
    }
}

// --- HANDLERS ---

pub async fn list_files_handler(State(state): State<SharedState>, Query(q): Query<ListQuery>) -> Response {
    let files = state.files.clone();

    let result = tokio::task::spawn_blocking(move || {
        if let Some(path) = q.path {
            if path.is_empty() {
                Ok(json!(files.get_drives()))
            } else {
                match files.list_directory(&path) {
                    Ok(entries) => Ok(json!(entries)),
                    Err(e) => {
                        let is_access_error = e.to_string().to_lowercase().contains("access");
                        Err(json!({
                            "status": "error",
                            "message": e.to_string(),
                            "no_access": is_access_error
                        }))
                    }
                }
            }
        } else {
            Ok(json!(files.get_drives()))
        }
    })
    .await
    .unwrap_or_else(|_| Err(json!({"status": "error", "message": "Thread pool failed"})));

    match result {
        Ok(val) => Json(val).into_response(),
        Err(err_val) => Json(err_val).into_response(),
    }
}

pub async fn create_folder_handler(
    State(state): State<SharedState>,
    Json(payload): Json<ActionPayload>,
) -> AppResult<Json<Value>> {
    let (Some(parent), Some(name)) = (payload.parent_path, payload.folder_name) else {
        return Err(AppError::BadRequest("Missing parentPath or folderName".to_string()));
    };

    let files = state.files.clone();
    tokio::task::spawn_blocking(move || files.create_folder(&parent, &name))
        .await
        .map_err(|e| anyhow!("Task failed: {}", e))??;

    Ok(Json(json!({"status": "success"})))
}

pub async fn delete_handler(
    State(state): State<SharedState>,
    Json(payload): Json<ActionPayload>,
) -> AppResult<Json<Value>> {
    let Some(paths) = payload.paths else {
        return Err(AppError::BadRequest("Missing paths".to_string()));
    };

    let files = state.files.clone();
    tokio::task::spawn_blocking(move || files.delete_items(paths))
        .await
        .map_err(|e| anyhow!("Task failed: {}", e))??;

    Ok(Json(json!({"status": "success"})))
}

pub async fn rename_handler(
    State(state): State<SharedState>,
    Json(payload): Json<ActionPayload>,
) -> AppResult<Json<Value>> {
    let (Some(old), Some(new)) = (payload.old_path, payload.new_name) else {
        return Err(AppError::BadRequest("Missing oldPath or newName".to_string()));
    };

    let files = state.files.clone();
    tokio::task::spawn_blocking(move || files.rename_item(&old, &new))
        .await
        .map_err(|e| anyhow!("Task failed: {}", e))??;

    Ok(Json(json!({"status": "success"})))
}

pub async fn upload_handler(State(_state): State<SharedState>, mut multipart: Multipart) -> AppResult<Json<Value>> {
    let mut target_dir = None;
    let mut temp_files: Vec<(String, TempFileGuard)> = Vec::new();
    let mut uploaded_count = 0;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();

        if name == "path" {
            if let Ok(txt) = field.text().await {
                target_dir = Some(txt);
            }
        } else if name == "files" {
            let raw_file_name = field.file_name().unwrap_or("uploaded_file");
            let file_name = std::path::Path::new(raw_file_name)
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("uploaded_file"))
                .to_string_lossy()
                .into_owned();
            let temp_uuid = Uuid::new_v4();
            let temp_path = std::env::temp_dir().join(format!("upload_{}", temp_uuid));

            let temp_guard = TempFileGuard {
                path: temp_path,
                disarmed: false,
            };

            if let Ok(mut file) = File::create(&temp_guard.path).await {
                let mut success = true;

                while let Ok(Some(chunk)) = field.chunk().await {
                    if file.write_all(&chunk).await.is_err() {
                        success = false;
                        break;
                    }
                }

                if success {
                    temp_files.push((file_name, temp_guard));
                }
            }
        }
    }

    let final_dir_str = target_dir.unwrap_or_else(|| ".".to_string());
    let final_dir = Path::new(&final_dir_str);

    let _ = tokio::fs::create_dir_all(final_dir).await;

    for (name, mut guard) in temp_files {
        let dest_path = final_dir.join(&name);
        match tokio::fs::rename(&guard.path, &dest_path).await {
            Ok(_) => {
                uploaded_count += 1;
                guard.disarmed = true;
            }
            Err(_) => match tokio::fs::copy(&guard.path, &dest_path).await {
                Ok(_) => uploaded_count += 1,
                Err(e) => tracing::error!("Failed to save file {}: {}", name, e),
            },
        }
    }

    Ok(Json(json!({"status": "success", "count": uploaded_count})))
}

struct TempFileGuard {
    path: PathBuf,
    disarmed: bool,
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            let path = self.path.clone();
            tokio::spawn(async move {
                let _ = tokio::fs::remove_file(path).await;
            });
        }
    }
}

pub async fn download_handler(State(_state): State<SharedState>, uri: Uri) -> AppResult<Response> {
    let query_str = uri.query().unwrap_or("");
    let query: DownloadQuery =
        serde_qs::from_str(query_str).map_err(|_| AppError::BadRequest("Invalid query parameters".to_string()))?;

    let paths = query.paths;
    if paths.is_empty() {
        return Err(AppError::BadRequest("No files selected".to_string()));
    }

    // Single file download (No changes needed here usually, unless you want to log it)
    if paths.len() == 1 {
        let path_str = &paths[0];
        let path = Path::new(path_str);

        if path.exists() {
            if path.is_file() {
                let file = File::open(path).await?;
                let stream = ReaderStream::new(file);
                let body = Body::from_stream(stream);
                let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let mime = from_path(path).first_or_octet_stream();

                let mut headers = HeaderMap::new();
                headers.insert(header::CONTENT_TYPE, mime.as_ref().parse().unwrap());
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", filename)
                        .parse()
                        .unwrap_or_else(|_| "attachment".parse().unwrap()),
                );

                return Ok((headers, body).into_response());
            }
            // If it's a directory, fall through to ZIP generation
        } else {
            return Err(AppError::NotFound("File not found".to_string()));
        }
    }

    let zip_filename = format!("download_{}.zip", Uuid::new_v4());
    let zip_path = std::env::temp_dir().join(&zip_filename);
    let zip_path_clone = zip_path.clone();

    let mut cleanup_guard = TempFileGuard {
        path: zip_path.clone(),
        disarmed: false,
    };

    // Create the Zip in a blocking task
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let file = std::fs::File::create(&zip_path_clone)?;
        let mut zip = zip::ZipWriter::new(file);

        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        let path_bufs: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
        let common_parent = find_common_parent(&path_bufs);

        for root_path in path_bufs {
            for entry in walkdir::WalkDir::new(&root_path).into_iter().filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    let zip_path_name = common_parent
                        .as_ref()
                        .and_then(|parent| path.strip_prefix(parent).ok())
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_else(|| path.file_name().unwrap().to_string_lossy().into_owned());

                    if zip.start_file(zip_path_name, options).is_ok()
                        && let Ok(mut f) = std::fs::File::open(path)
                    {
                        let _ = std::io::copy(&mut f, &mut zip);
                    }
                }
            }
        }
        zip.finish()?;
        Ok(())
    })
    .await;

    result.map_err(|e| anyhow!("Task failed: {}", e))??;

    let file = File::open(&zip_path).await?;
    let stream = ReaderStream::new(file);

    cleanup_guard.disarmed = true;

    let wrapped_stream = DeleteOnDropStream {
        inner: stream,
        path: zip_path,
    };

    let body = Body::from_stream(wrapped_stream);

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        "attachment; filename=\"files.zip\"".parse().unwrap(),
    );

    Ok((headers, body).into_response())
}
