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
    let mut temp_files: Vec<(String, tempfile::TempPath)> = Vec::new();
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

            let named_temp = match tokio::task::spawn_blocking(tempfile::NamedTempFile::new).await {
                Ok(Ok(ntf)) => ntf,
                _ => continue,
            };

            let (std_file, temp_path) = named_temp.into_parts();
            let mut file = File::from_std(std_file);

            let mut success = true;
            while let Ok(Some(chunk)) = field.chunk().await {
                if file.write_all(&chunk).await.is_err() {
                    success = false;
                    break;
                }
            }

            if success {
                let _ = file.flush().await;
                drop(file);
                temp_files.push((file_name, temp_path));
            }
        }
    }

    let final_dir_str = target_dir.unwrap_or_else(|| ".".to_string());
    let final_dir = Path::new(&final_dir_str);

    let _ = tokio::fs::create_dir_all(final_dir).await;

    for (name, temp_path) in temp_files {
        let dest_path = final_dir.join(&name);

        let res = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            match temp_path.persist(&dest_path) {
                Ok(_) => Ok(()),
                Err(e) => {
                    std::fs::copy(&e.path, &dest_path)?;
                    Ok(())
                }
            }
        })
        .await;

        if let Ok(Ok(_)) = res {
            uploaded_count += 1;
        } else {
            tracing::error!("Failed to save file {}", name);
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
