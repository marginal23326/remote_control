use crate::services::files::FileManager;
use crate::utils::error::{AppError, AppResult};
use anyhow::anyhow;
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Query},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use axum_extra::extract::Form;
use mime_guess::from_path;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Seek;
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

// --- DATA STRUCTURES ---

#[derive(Deserialize)]
pub struct ListQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct DownloadForm {
    #[serde(default, rename = "paths[]")]
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

fn systime_to_zip_datetime(systime: std::time::SystemTime) -> Option<zip::DateTime> {
    use time::OffsetDateTime;
    let utc_dt: OffsetDateTime = systime.into();
    let offset = time::UtcOffset::current_local_offset().ok()?;
    let local_dt = utc_dt.to_offset(offset);
    zip::DateTime::from_date_and_time(
        local_dt.year() as u16,
        local_dt.month() as u8,
        local_dt.day(),
        local_dt.hour(),
        local_dt.minute(),
        local_dt.second(),
    )
    .ok()
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

pub async fn check_access_handler(Json(mut paths): Json<Vec<String>>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        paths.truncate(200);
        paths
            .into_iter()
            .filter(|p| std::fs::read_dir(std::path::Path::new(p)).is_err())
            .collect::<Vec<String>>()
    })
    .await
    .unwrap_or_default();

    Json(result).into_response()
}

pub async fn list_files_handler(Query(q): Query<ListQuery>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        if let Some(path) = q.path {
            if path.is_empty() {
                Ok(json!(FileManager::get_drives()))
            } else {
                match FileManager::list_directory(&path) {
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
            Ok(json!(FileManager::get_drives()))
        }
    })
    .await
    .unwrap_or_else(|_| Err(json!({"status": "error", "message": "Thread pool failed"})));

    match result {
        Ok(val) => Json(val).into_response(),
        Err(err_val) => Json(err_val).into_response(),
    }
}

pub async fn create_folder_handler(Json(payload): Json<ActionPayload>) -> AppResult<Json<Value>> {
    let (Some(parent), Some(name)) = (payload.parent_path, payload.folder_name) else {
        return Err(AppError::BadRequest("Missing parentPath or folderName".to_string()));
    };

    tokio::task::spawn_blocking(move || FileManager::create_folder(&parent, &name))
        .await
        .map_err(|e| anyhow!("Task failed: {}", e))??;

    Ok(Json(json!({"status": "success"})))
}

pub async fn delete_handler(Json(payload): Json<ActionPayload>) -> AppResult<Json<Value>> {
    let Some(paths) = payload.paths else {
        return Err(AppError::BadRequest("Missing paths".to_string()));
    };

    tokio::task::spawn_blocking(move || FileManager::delete_items(paths))
        .await
        .map_err(|e| anyhow!("Task failed: {}", e))??;

    Ok(Json(json!({"status": "success"})))
}

pub async fn rename_handler(Json(payload): Json<ActionPayload>) -> AppResult<Json<Value>> {
    let (Some(old), Some(new)) = (payload.old_path, payload.new_name) else {
        return Err(AppError::BadRequest("Missing oldPath or newName".to_string()));
    };

    tokio::task::spawn_blocking(move || FileManager::rename_item(&old, &new))
        .await
        .map_err(|e| anyhow!("Task failed: {}", e))??;

    Ok(Json(json!({"status": "success"})))
}

pub async fn upload_handler(mut multipart: Multipart) -> AppResult<Json<Value>> {
    let mut target_dir = None;
    let mut uploaded_count = 0;
    let mut dir_created = false;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();

        if name == "path" {
            if let Ok(txt) = field.text().await {
                target_dir = Some(txt);
            }
        } else if name == "files" {
            let Some(ref dir_str) = target_dir else {
                return Err(AppError::BadRequest(
                    "Field 'path' must precede 'files' in the request payload".to_string(),
                ));
            };
            let dir_path = std::path::Path::new(dir_str.as_str());

            let raw_file_name = field.file_name().unwrap_or("uploaded_file");
            let file_name = std::path::Path::new(raw_file_name)
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("uploaded_file"))
                .to_string_lossy()
                .into_owned();

            if !dir_created {
                if let Err(e) = tokio::fs::create_dir_all(dir_path).await {
                    tracing::error!("Failed to create directory {}: {}", dir_str, e);
                    continue;
                }
                dir_created = true;
            }

            let named_temp = match tokio::task::spawn_blocking({
                let dir_path = dir_path.to_path_buf();
                move || {
                    tempfile::Builder::new()
                        .prefix(".upload_")
                        .suffix(".part")
                        .tempfile_in(dir_path)
                }
            })
            .await
            {
                Ok(Ok(ntf)) => ntf,
                _ => continue,
            };

            // into_parts() gives TempPath which retains the Drop guard that auto-deletes the file.
            let (std_file, temp_path) = named_temp.into_parts();
            let dest_path = dir_path.join(&file_name);

            let mut file = tokio::fs::File::from_std(std_file);

            let mut success = false;
            loop {
                match field.chunk().await {
                    Ok(Some(chunk)) => {
                        if file.write_all(&chunk).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        success = true;
                        break;
                    }
                    Err(e) => {
                        tracing::error!("Upload stream interrupted: {}", e);
                        break;
                    }
                }
            }

            if success && file.flush().await.is_ok() {
                drop(file);

                let dest = dest_path.clone();
                match tokio::task::spawn_blocking(move || temp_path.persist(dest)).await {
                    Ok(Ok(_)) => {
                        uploaded_count += 1;
                    }
                    Ok(Err(e)) => {
                        tracing::error!("Failed to persist temp file to {:?}: {}", dest_path, e);
                    }
                    Err(e) => {
                        tracing::error!("Thread pool task failed during rename: {}", e);
                    }
                }
            }
        }
    }

    Ok(Json(json!({"status": "success", "count": uploaded_count})))
}

pub async fn download_handler(Form(payload): Form<DownloadForm>) -> AppResult<Response> {
    let paths = payload.paths;
    if paths.is_empty() {
        return Err(AppError::BadRequest("No files selected".to_string()));
    }

    // Single file download
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

                let encoded: String = filename
                    .bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                            (b as char).to_string()
                        } else {
                            format!("%{:02X}", b)
                        }
                    })
                    .collect();
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename*=UTF-8''{}", encoded)
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

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<std::fs::File> {
        let temp_file = tempfile::tempfile()?;
        let mut zip = zip::ZipWriter::new(temp_file);

        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

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

                    let last_modified = entry
                        .metadata()
                        .ok()
                        .and_then(|meta| meta.modified().ok())
                        .and_then(systime_to_zip_datetime)
                        .unwrap_or_default();

                    let file_options = options.last_modified_time(last_modified);

                    if zip.start_file(zip_path_name, file_options).is_ok()
                        && let Ok(mut f) = std::fs::File::open(path)
                    {
                        let _ = std::io::copy(&mut f, &mut zip);
                    }
                }
            }
        }

        let mut temp_file = zip.finish()?;
        temp_file.seek(std::io::SeekFrom::Start(0))?;

        Ok(temp_file)
    })
    .await;

    let temp_file = result.map_err(|e| anyhow!("Task failed: {}", e))??;

    let file = File::from_std(temp_file);
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        "attachment; filename=\"files.zip\"".parse().unwrap(),
    );

    Ok((headers, body).into_response())
}
