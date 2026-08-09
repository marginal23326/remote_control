use crate::services::files;
use crate::utils::blocking::run_blocking;
use crate::utils::error::{AppError, AppResult, success};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Query},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use axum_extra::extract::Form;
use futures_util::TryStreamExt;
use mime_guess::from_path;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use tokio::fs::File;
use tokio::io::duplex;
use tokio_util::io::{ReaderStream, StreamReader};

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

impl From<files::FileOpError> for AppError {
    fn from(e: files::FileOpError) -> Self {
        let message = e.to_string();
        match e {
            files::FileOpError::NotFound => AppError::NotFound(message),
            files::FileOpError::AccessDenied(_) => AppError::Forbidden(message),
            files::FileOpError::InvalidName | files::FileOpError::InvalidPath | files::FileOpError::AlreadyExists => {
                AppError::BadRequest(message)
            }
            files::FileOpError::DeleteFailed(_) => AppError::InternalError(anyhow::anyhow!(message)),
            files::FileOpError::Io(io_err) => AppError::InternalError(io_err.into()),
        }
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
    .await?;

    Ok(Json(inaccessible))
}

pub async fn list_files_handler(Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let Some(path) = q.path.filter(|p| !p.is_empty()) else {
        return Ok(Json(json!(files::get_drives())));
    };

    let entries = run_blocking(move || files::list_directory(&path)).await?;

    Ok(Json(json!(entries)))
}

pub async fn get_home_handler() -> Response {
    let path = files::get_home_dir();
    Json(json!({ "path": path })).into_response()
}

pub async fn create_folder_handler(Json(payload): Json<CreateFolderPayload>) -> AppResult<Json<Value>> {
    run_blocking(move || files::create_folder(&payload.parent_path, &payload.folder_name)).await?;

    Ok(success!())
}

pub async fn delete_handler(Json(payload): Json<DeletePayload>) -> AppResult<Json<Value>> {
    run_blocking(move || files::delete_items(payload.paths)).await?;

    Ok(success!())
}

pub async fn rename_handler(Json(payload): Json<RenamePayload>) -> AppResult<Json<Value>> {
    run_blocking(move || files::rename_item(&payload.old_path, &payload.new_name)).await?;

    Ok(success!())
}

pub async fn upload_handler(Query(query): Query<UploadQuery>, mut multipart: Multipart) -> AppResult<Json<Value>> {
    let dir_path = Path::new(&query.path);
    let mut uploaded_count = 0;
    let mut dir_created = false;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name != "files" {
            continue;
        }

        let raw_file_name = field.file_name().unwrap_or("uploaded_file");
        let file_name = Path::new(raw_file_name)
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

        let reader = StreamReader::new(field.map_err(io::Error::other));
        match files::save_uploaded_file(dir_path, &file_name, reader).await {
            Ok(()) => uploaded_count += 1,
            Err(e) => tracing::error!("Failed to save uploaded file {file_name:?}: {e:#}"),
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

        if !path.exists() {
            return Err(AppError::NotFound("File not found".to_string()));
        }

        if path.is_file() {
            let file = File::open(path).await.map_err(anyhow::Error::from)?;
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
    }

    let (files_to_zip, skipped) = run_blocking(move || files::plan_zip_entries(&paths)).await?;

    if files_to_zip.is_empty() {
        return Err(AppError::BadRequest(
            "None of the selected items could be read".to_string(),
        ));
    }

    let (w, r) = duplex(1024 * 1024);
    tokio::spawn(files::write_zip_archive(files_to_zip, skipped, w));

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
