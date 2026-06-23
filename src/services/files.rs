use anyhow::{Result, anyhow};
use jiff::Timestamp;
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
    pub last_modified: Option<String>,
    pub no_access: bool,
}

#[derive(Serialize, Debug)]
pub struct DriveEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub drive_type: u8,
}

pub struct FileManager;

impl FileManager {
    pub fn new() -> Self {
        Self
    }

    pub fn get_drives(&self) -> Vec<DriveEntry> {
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

    /// Helper to check if we have read access to a directory
    fn check_dir_access(&self, path: &Path) -> bool {
        // Try to read the directory. If it fails, we assume no access.
        fs::read_dir(path).is_ok()
    }

    pub fn list_directory(&self, path_str: &str) -> Result<Vec<FileEntry>> {
        let path = Path::new(path_str);

        if !path.exists() {
            return Err(anyhow!("Path does not exist"));
        }

        let mut entries = Vec::new();
        let read_dir = fs::read_dir(path).map_err(|e| anyhow!("Access denied: {}", e))?;

        for entry in read_dir.flatten() {
            let file_type = entry.file_type().ok();
            let metadata_res = entry.metadata();

            // If we can't get metadata, use defaults
            let (is_dir, len, modified_str) = if let Ok(meta) = metadata_res {
                let date = meta
                    .modified()
                    .ok()
                    .and_then(|t| Timestamp::try_from(t).ok())
                    .map(|ts| ts.to_string());
                (meta.is_dir(), meta.len(), date)
            } else {
                let is_dir = file_type.map(|ft| ft.is_dir()).unwrap_or(false);
                (is_dir, 0, None)
            };

            let full_path_buf = entry.path();
            let full_path = full_path_buf.to_string_lossy().to_string();
            let file_name = entry.file_name().to_string_lossy().to_string();

            // Check access for subdirectories
            let mut no_access = false;
            if is_dir {
                no_access = !self.check_dir_access(&full_path_buf);
            }

            entries.push(FileEntry {
                name: file_name,
                path: full_path,
                is_dir,
                size: len,
                last_modified: modified_str,
                no_access,
            });
        }

        // Sort: Directories first, then files (case-insensitive)
        entries.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir).then_with(|| {
                a.name
                    .bytes()
                    .map(|b| b.to_ascii_lowercase())
                    .cmp(b.name.bytes().map(|b| b.to_ascii_lowercase()))
            })
        });

        Ok(entries)
    }

    pub fn create_folder(&self, parent: &str, name: &str) -> Result<()> {
        let path = Path::new(parent).join(name);
        fs::create_dir(path)?;
        Ok(())
    }

    pub fn delete_items(&self, paths: Vec<String>) -> Result<Vec<String>> {
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
            return Err(anyhow!("Failed to delete some items: {:?}", failed));
        }
        Ok(vec![])
    }

    pub fn rename_item(&self, old: &str, new_name: &str) -> Result<()> {
        let old_path = Path::new(old);
        let parent = old_path.parent().ok_or_else(|| anyhow!("Invalid path"))?;
        let new_path = parent.join(new_name);
        fs::rename(old_path, new_path)?;
        Ok(())
    }
}
