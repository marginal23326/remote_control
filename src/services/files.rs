use anyhow::Result;
use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use sysinfo::Disks;
use thiserror::Error;
use tokio_util::compat::FuturesAsyncWriteCompatExt;
use ts_rs::TS;

#[derive(Serialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts", optional_fields = nullable)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub last_modified: Option<i64>,
}

#[derive(Serialize, Debug, TS)]
#[ts(export, export_to = "bindings.ts")]
pub struct DriveEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub fn get_drives() -> Vec<DriveEntry> {
    let disks = Disks::new_with_refreshed_list();

    disks
        .iter()
        .map(|disk| {
            let path = disk.mount_point().to_string_lossy().to_string();
            DriveEntry {
                name: format!("{} ({:?})", path, disk.kind()),
                path: path.clone(),
                is_dir: true,
            }
        })
        .collect()
}

#[derive(Error, Debug)]
pub enum FileOpError {
    #[error("Path does not exist")]
    NotFound,
    #[error("Access denied: {0}")]
    AccessDenied(#[source] std::io::Error),
    #[error("Invalid file name")]
    InvalidName,
    #[error("Invalid path")]
    InvalidPath,
    #[error("A file or folder with that name already exists")]
    AlreadyExists,
    #[error("Failed to delete: {0}")]
    DeleteFailed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub fn list_directory(path_str: &str) -> Result<Vec<FileEntry>, FileOpError> {
    let path = Path::new(path_str);

    if !path.exists() {
        return Err(FileOpError::NotFound);
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(path).map_err(FileOpError::AccessDenied)?;

    for entry in read_dir.flatten() {
        let file_type = entry.file_type().ok();
        let metadata_res = entry.metadata();

        let (is_dir, len, modified_millis) = metadata_res
            .map(|meta| {
                let millis = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64);
                (meta.is_dir(), meta.len(), millis)
            })
            .unwrap_or_else(|_| {
                let is_dir = file_type.map(|ft| ft.is_dir()).unwrap_or(false);
                (is_dir, 0, None)
            });

        let full_path_buf = entry.path();
        let full_path = full_path_buf.to_string_lossy().to_string();
        let file_name = entry.file_name().to_string_lossy().to_string();

        entries.push(FileEntry {
            name: file_name,
            path: full_path,
            is_dir,
            size: len,
            last_modified: modified_millis,
        });
    }

    Ok(entries)
}

pub fn create_folder(parent: &str, name: &str) -> Result<(), FileOpError> {
    let path = Path::new(parent).join(name);
    fs::create_dir(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => FileOpError::AlreadyExists,
        _ => FileOpError::Io(e),
    })
}

pub fn delete_items(paths: Vec<String>) -> Result<(), FileOpError> {
    let mut failed = Vec::new();
    for p in paths {
        let path = Path::new(&p);
        let res = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };

        if res.is_err() {
            failed.push(p);
        }
    }

    if !failed.is_empty() {
        return Err(FileOpError::DeleteFailed(failed.join(", ")));
    }
    Ok(())
}

pub fn rename_item(old: &str, new_name: &str) -> Result<(), FileOpError> {
    if new_name.contains(['/', '\\']) {
        return Err(FileOpError::InvalidName);
    }

    let old_path = Path::new(old);
    let parent = old_path.parent().ok_or(FileOpError::InvalidPath)?;
    let new_path = parent.join(new_name);

    if new_path.exists() {
        return Err(FileOpError::AlreadyExists);
    }

    fs::rename(old_path, new_path)?;
    Ok(())
}

#[cfg(windows)]
fn fallback_root() -> &'static str {
    "C:\\"
}

#[cfg(not(windows))]
fn fallback_root() -> &'static str {
    "/"
}

pub fn get_home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| fallback_root().to_string())
}

pub async fn save_uploaded_file<R>(dir: &Path, file_name: &str, mut reader: R) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let named_temp = tokio::task::spawn_blocking({
        let dir = dir.to_path_buf();
        move || {
            tempfile::Builder::new()
                .prefix(".upload_")
                .suffix(".part")
                .tempfile_in(dir)
        }
    })
    .await??;

    // into_parts() gives TempPath which retains the Drop guard that auto-deletes the file.
    let (std_file, temp_path) = named_temp.into_parts();
    let mut file = tokio::fs::File::from_std(std_file);

    tokio::io::copy(&mut reader, &mut file).await?;
    drop(file);

    let dest = dir.join(file_name);
    tokio::task::spawn_blocking(move || temp_path.persist(dest)).await??;

    Ok(())
}

pub struct ZipPlanEntry {
    fs_path: PathBuf,
    zip_path: String,
    last_modified: async_zip::ZipDateTime,
}

fn systime_to_zip_datetime(systime: std::time::SystemTime, offset: time::UtcOffset) -> async_zip::ZipDateTime {
    use time::OffsetDateTime;
    let utc_dt: OffsetDateTime = systime.into();
    let local_dt = utc_dt.to_offset(offset);
    async_zip::ZipDateTimeBuilder::new()
        .year(local_dt.year())
        .month(local_dt.month() as u32)
        .day(local_dt.day() as u32)
        .hour(local_dt.hour() as u32)
        .minute(local_dt.minute() as u32)
        .second(local_dt.second() as u32)
        .build()
}

fn find_common_parent(paths: &[PathBuf]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }
    let mut common = paths[0].parent().unwrap_or(&paths[0]).to_path_buf();
    for path in paths.iter().skip(1) {
        let parent = path.parent().unwrap_or(path);
        let mut new_common = PathBuf::new();
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

pub fn plan_zip_entries(paths: &[String]) -> Result<(Vec<ZipPlanEntry>, Vec<String>)> {
    let mut collected = Vec::new();
    let mut skipped = Vec::new();
    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let common_parent = find_common_parent(&path_bufs);
    let tz_offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);

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
                let zip_path = common_parent
                    .as_ref()
                    .and_then(|parent| path.strip_prefix(parent).ok())
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|| path.file_name().unwrap().to_string_lossy().into_owned());

                let last_modified = entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .map(|systime| systime_to_zip_datetime(systime, tz_offset))
                    .unwrap_or_default();

                collected.push(ZipPlanEntry {
                    fs_path: path.to_path_buf(),
                    zip_path,
                    last_modified,
                });
            }
        }
    }
    Ok((collected, skipped))
}

pub async fn write_zip_archive<W>(entries: Vec<ZipPlanEntry>, skipped: Vec<String>, writer: W)
where
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mut writer = ZipFileWriter::with_tokio(writer);

    if !skipped.is_empty() {
        let header = "The following paths could not be read and were excluded from the archive:\n\n";
        let content = format!("{header}{}", skipped.join("\n"));
        let entry = ZipEntryBuilder::new("_skipped.txt".into(), Compression::Stored);
        if let Ok(entry_writer) = writer.write_entry_stream(entry).await {
            let mut compat_writer = entry_writer.compat_write();
            let _ = tokio::io::copy(&mut content.as_bytes(), &mut compat_writer).await;
            let _ = compat_writer.into_inner().close().await;
        }
    }

    for entry in entries {
        if let Ok(mut f) = tokio::fs::File::open(&entry.fs_path).await {
            let builder = ZipEntryBuilder::new(entry.zip_path.into(), Compression::Stored)
                .last_modification_date(entry.last_modified);

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
}
