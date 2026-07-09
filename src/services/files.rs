use anyhow::{Result, anyhow};
use serde::Serialize;
use std::fs;
use std::path::Path;
use sysinfo::Disks;

#[derive(Serialize, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub last_modified: Option<i64>,
}

#[derive(Serialize, Debug)]
pub struct DriveEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub drive_type: u8,
}

#[derive(Clone)]
pub struct FileManager;

impl FileManager {
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
                    drive_type: 3,
                }
            })
            .collect()
    }

    pub fn list_directory(path_str: &str) -> Result<Vec<FileEntry>> {
        let path = Path::new(path_str);

        if !path.exists() {
            return Err(anyhow!("Path does not exist"));
        }

        let mut entries = Vec::new();
        let read_dir = fs::read_dir(path).map_err(|e| anyhow!("Access denied: {}", e))?;

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

    pub fn create_folder(parent: &str, name: &str) -> Result<()> {
        let path = Path::new(parent).join(name);
        fs::create_dir(path)?;
        Ok(())
    }

    pub fn delete_items(paths: Vec<String>) -> Result<Vec<String>> {
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
            return Err(anyhow!("Failed to delete: {}", failed.join(", ")));
        }
        Ok(vec![])
    }

    pub fn rename_item(old: &str, new_name: &str) -> Result<()> {
        if new_name.contains(['/', '\\']) {
            return Err(anyhow!("Invalid file name"));
        }

        let old_path = Path::new(old);
        let parent = old_path.parent().ok_or_else(|| anyhow!("Invalid path"))?;
        let new_path = parent.join(new_name);

        if new_path.exists() {
            return Err(anyhow!("A file or folder with that name already exists"));
        }

        fs::rename(old_path, new_path)?;
        Ok(())
    }

    pub fn get_home_dir() -> String {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| String::from(if cfg!(windows) { "C:\\" } else { "/" }))
    }
}
