use crate::services::files;
use crate::utils::error::{AppError, AppResult, run_blocking, success};
use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Query},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use axum_extra::extract::Form;
use mime_guess::from_path;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::io::duplex;
use tokio_util::compat::FuturesAsyncWriteCompatExt;
use tokio_util::io::ReaderStream;

const FILENAME_SAFE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

// --- DATA STRUCTURES ---

#[derive(Deserialize)]
pub struct ListQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct UploadQuery {
    path: String,
}

#[derive(Deserialize)]
pub struct DownloadForm {
    #[serde(default, rename = "paths[]")]
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderPayload {
    parent_path: String,
    folder_name: String,
}

#[derive(Deserialize)]
pub struct DeletePayload {
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePayload {
    old_path: String,
    new_name: String,
}

fn systime_to_zip_datetime(systime: std::time::SystemTime) -> Option<async_zip::ZipDateTime> {
    use time::OffsetDateTime;
    let utc_dt: OffsetDateTime = systime.into();
    let offset = time::UtcOffset::current_local_offset().ok()?;
    let local_dt = utc_dt.to_offset(offset);
    Some(
        async_zip::ZipDateTimeBuilder::new()
            .year(local_dt.year())
            .month(local_dt.month() as u32)
            .day(local_dt.day() as u32)
            .hour(local_dt.hour() as u32)
            .minute(local_dt.minute() as u32)
            .second(local_dt.second() as u32)
            .build(),
    )
}

fn find_common_parent(paths: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    if paths.is_empty() {
        return None;
    }
    let mut common = paths[0].parent().unwrap_or(&paths[0]).to_path_buf();
    for path in paths.iter().skip(1) {
        let parent = path.parent().unwrap_or(path);
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

pub async fn check_access_handler(Json(mut paths): Json<Vec<String>>) -> AppResult<Json<Vec<String>>> {
    let inaccessible = run_blocking(move || -> anyhow::Result<Vec<String>> {
        paths.truncate(200);
        Ok(paths
            .into_iter()
            .filter(|p| std::fs::read_dir(std::path::Path::new(p)).is_err())
            .collect())
    })
    .await??;

    Ok(Json(inaccessible))
}

pub async fn list_files_handler(Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let Some(path) = q.path.filter(|p| !p.is_empty()) else {
        return Ok(Json(json!(files::get_drives())));
    };

    let entries = run_blocking(move || files::list_directory(&path)).await?.map_err(|e| {
        let message = e.to_string();
        if message.to_lowercase().contains("access") {
            AppError::Forbidden(message)
        } else if message.contains("does not exist") {
            AppError::NotFound(message)
        } else {
            AppError::InternalError(e)
        }
    })?;

    Ok(Json(json!(entries)))
}

pub async fn get_home_handler() -> Response {
    let path = files::get_home_dir();
    Json(json!({ "path": path })).into_response()
}

pub async fn create_folder_handler(Json(payload): Json<CreateFolderPayload>) -> AppResult<Json<Value>> {
    run_blocking(move || files::create_folder(&payload.parent_path, &payload.folder_name)).await??;

    Ok(success!())
}

pub async fn delete_handler(Json(payload): Json<DeletePayload>) -> AppResult<Json<Value>> {
    run_blocking(move || files::delete_items(payload.paths)).await??;

    Ok(success!())
}

pub async fn rename_handler(Json(payload): Json<RenamePayload>) -> AppResult<Json<Value>> {
    run_blocking(move || files::rename_item(&payload.old_path, &payload.new_name)).await??;

    Ok(success!())
}

pub async fn upload_handler(Query(query): Query<UploadQuery>, mut multipart: Multipart) -> AppResult<Json<Value>> {
    let dir_path = std::path::Path::new(&query.path);
    let mut uploaded_count = 0;
    let mut dir_created = false;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();

        if name == "files" {
            let raw_file_name = field.file_name().unwrap_or("uploaded_file");
            let file_name = std::path::Path::new(raw_file_name)
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("uploaded_file"))
                .to_string_lossy()
                .into_owned();

            if !dir_created {
                if let Err(e) = tokio::fs::create_dir_all(dir_path).await {
                    return Err(AppError::BadRequest(format!(
                        "Failed to create directory {}: {}",
                        query.path, e
                    )));
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

    Ok(success!("count": uploaded_count))
}

pub async fn download_handler(Form(payload): Form<DownloadForm>) -> AppResult<Response> {
    let paths = payload.paths;
    if paths.is_empty() {
        return Err(AppError::BadRequest("No files selected".to_string()));
    }

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

                let encoded = utf8_percent_encode(&filename, FILENAME_SAFE).to_string();
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename*=UTF-8''{}", encoded)
                        .parse()
                        .unwrap_or_else(|_| "attachment".parse().unwrap()),
                );

                return Ok((headers, body).into_response());
            }
        } else {
            return Err(AppError::NotFound("File not found".to_string()));
        }
    }

    let paths_clone = paths.clone();
    let (files_to_zip, skipped) = run_blocking(move || -> anyhow::Result<_> {
        let mut collected = Vec::new();
        let mut skipped = Vec::new();
        let path_bufs: Vec<std::path::PathBuf> = paths_clone.iter().map(std::path::PathBuf::from).collect();
        let common_parent = find_common_parent(&path_bufs);

        for root_path in path_bufs {
            for entry in walkdir::WalkDir::new(&root_path) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        if let Some(path) = e.path() {
                            skipped.push(path.to_string_lossy().into_owned());
                        }
                        continue;
                    }
                };
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

                    collected.push((path.to_path_buf(), zip_path_name, last_modified));
                }
            }
        }
        Ok((collected, skipped))
    })
    .await??;

    if files_to_zip.is_empty() {
        return Err(AppError::BadRequest(
            "None of the selected items could be read".to_string(),
        ));
    }

    let (w, r) = duplex(1024 * 1024);

    tokio::spawn(async move {
        let mut writer = ZipFileWriter::with_tokio(w);

        if !skipped.is_empty() {
            let header = "The following paths could not be read and were excluded from the archive:\n\n";
            let content = format!("{}{}", header, skipped.join("\n"));
            let entry = ZipEntryBuilder::new("_skipped.txt".into(), Compression::Stored);
            if let Ok(entry_writer) = writer.write_entry_stream(entry).await {
                let mut compat_writer = entry_writer.compat_write();
                let _ = tokio::io::copy(&mut content.as_bytes(), &mut compat_writer).await;
                let _ = compat_writer.into_inner().close().await;
            }
        }

        for (fs_path, zip_path, last_modified) in files_to_zip {
            if let Ok(mut f) = tokio::fs::File::open(&fs_path).await {
                let builder =
                    ZipEntryBuilder::new(zip_path.into(), Compression::Stored).last_modification_date(last_modified);

                if let Ok(entry_writer) = writer.write_entry_stream(builder).await {
                    let mut compat_writer = entry_writer.compat_write();
                    if tokio::io::copy(&mut f, &mut compat_writer).await.is_err() {
                        break;
                    }
                    if compat_writer.into_inner().close().await.is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
        let _ = writer.close().await;
    });

    let stream = ReaderStream::new(r);
    let body = Body::from_stream(stream);

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"files.zip\""),
    );

    Ok((headers, body).into_response())
}
