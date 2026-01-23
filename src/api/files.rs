use axum::{
    extract::{State, Query, Multipart},
    Json,
    http::{header, HeaderMap, Uri},
    response::{IntoResponse, Response},
    body::Body,
};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::state::SharedState;
use crate::utils::error::{AppError, AppResult};
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use uuid::Uuid;
use mime_guess::from_path;
use anyhow::anyhow;

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

// --- HANDLERS ---

pub async fn list_files_handler(
    State(state): State<SharedState>,
    Query(q): Query<ListQuery>,
) -> Response {
    let files = state.files.lock().unwrap();
    
    let result = if let Some(path) = q.path {
        if path == "/" || path.is_empty() {
             json!(files.get_drives())
        } else {
             match files.list_directory(&path) {
                 Ok(entries) => json!(entries),
                 Err(e) => {
                     let is_access_error = e.to_string().to_lowercase().contains("access");
                     return Json(json!({
                         "status": "error", 
                         "message": e.to_string(),
                         "no_access": is_access_error 
                     })).into_response()
                 },
             }
        }
    } else {
        json!(files.get_drives())
    };

    Json(result).into_response()
}

pub async fn create_folder_handler(
    State(state): State<SharedState>,
    Json(payload): Json<ActionPayload>,
) -> AppResult<Json<Value>> {
    let files = state.files.lock().unwrap();
    if let (Some(parent), Some(name)) = (payload.parent_path, payload.folder_name) {
        files.create_folder(&parent, &name)?; 
    }
    Ok(Json(json!({"status": "success"})))
}

pub async fn delete_handler(
    State(state): State<SharedState>,
    Json(payload): Json<ActionPayload>,
) -> AppResult<Json<Value>> {
    let files = state.files.lock().unwrap();
    if let Some(paths) = payload.paths {
        files.delete_items(paths)?;
    }
    Ok(Json(json!({"status": "success"})))
}

pub async fn rename_handler(
    State(state): State<SharedState>,
    Json(payload): Json<ActionPayload>,
) -> AppResult<Json<Value>> {
    let files = state.files.lock().unwrap();
    if let (Some(old), Some(new)) = (payload.old_path, payload.new_name) {
        files.rename_item(&old, &new)?;
    }
    Ok(Json(json!({"status": "success"})))
}

pub async fn upload_handler(
    State(_state): State<SharedState>,
    mut multipart: Multipart,
) -> AppResult<Json<Value>> {
    let mut target_dir = None;
    let mut temp_files: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut uploaded_count = 0;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        
        if name == "path" {
            if let Ok(txt) = field.text().await {
                target_dir = Some(txt);
            }
        } else if name == "files" {
            let file_name = field.file_name().unwrap_or("uploaded_file").to_string();
            let temp_uuid = Uuid::new_v4();
            let temp_path = std::env::temp_dir().join(format!("upload_{}", temp_uuid));
            
            if let Ok(data) = field.bytes().await {
                let mut file = File::create(&temp_path).await?;
                file.write_all(&data).await?;
                temp_files.push((file_name, temp_path));
            }
        }
    }

    let final_dir_str = target_dir.unwrap_or_else(|| ".".to_string());
    let final_dir = Path::new(&final_dir_str);

    for (name, temp_path) in temp_files {
        let dest_path = final_dir.join(&name);
        match tokio::fs::rename(&temp_path, &dest_path).await {
            Ok(_) => uploaded_count += 1,
            Err(_) => {
                match tokio::fs::copy(&temp_path, &dest_path).await {
                    Ok(_) => {
                        let _ = tokio::fs::remove_file(temp_path).await;
                        uploaded_count += 1;
                    }
                    Err(e) => tracing::error!("Failed to save file {}: {}", name, e),
                }
            }
        }
    }

    Ok(Json(json!({"status": "success", "count": uploaded_count})))
}

pub async fn download_handler(
    State(_state): State<SharedState>,
    uri: Uri,
) -> AppResult<Response> {
    let query_str = uri.query().unwrap_or("");
    let query: DownloadQuery = serde_qs::from_str(query_str)
        .map_err(|_| AppError::BadRequest("Invalid query parameters".to_string()))?;
    
    let paths = query.paths;
    if paths.is_empty() {
        return Err(AppError::BadRequest("No files selected".to_string()));
    }

    if paths.len() == 1 {
        let path_str = &paths[0];
        let path = Path::new(path_str);
        
        if path.exists() && path.is_file() {
            let file = File::open(path).await?;
            let stream = ReaderStream::new(file);
            let body = Body::from_stream(stream);
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let mime = from_path(path).first_or_octet_stream();

            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, mime.as_ref().parse().unwrap());
            headers.insert(
                header::CONTENT_DISPOSITION, 
                format!("attachment; filename=\"{}\"", filename).parse().unwrap_or_else(|_| "attachment".parse().unwrap())
            );

            return Ok((headers, body).into_response());
        } else {
             return Err(AppError::NotFound("File not found".to_string()));
        }
    }

    let zip_filename = format!("download_{}.zip", Uuid::new_v4());
    let zip_path = std::env::temp_dir().join(&zip_filename);
    let zip_path_clone = zip_path.clone();

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let file = std::fs::File::create(&zip_path_clone)?;
        let mut zip = zip::ZipWriter::new(file);
        
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o755);

        for p in paths {
            let path = Path::new(&p);
            if path.is_file() {
                let name = path.file_name().unwrap().to_string_lossy();
                let _ = zip.start_file(name, options);
                let mut f = std::fs::File::open(path)?;
                std::io::copy(&mut f, &mut zip)?;
            }
        }
        zip.finish()?;
        Ok(())
    }).await;

    let _ = result.map_err(|e| anyhow!("Task failed: {}", e))??;

    let file = File::open(&zip_path).await?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    headers.insert(header::CONTENT_DISPOSITION, "attachment; filename=\"files.zip\"".parse().unwrap());

    Ok((headers, body).into_response())
}