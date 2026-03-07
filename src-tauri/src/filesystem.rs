use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct FilesystemEntry {
    pub name: String,
    pub path: String,
    pub entry_type: String,
}

#[derive(Serialize)]
pub struct FilesystemListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<FilesystemEntry>,
}

#[derive(Serialize)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn find_default_logos_dir() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("logos"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("logos"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("logos"));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn get_image_dimensions(path: String) -> Result<ImageDimensions, String> {
    let image_path = PathBuf::from(&path);
    if !image_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !image_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }

    let (width, height) = image::image_dimensions(&image_path)
        .map_err(|error| format!("Failed to read image dimensions '{}': {}", path, error))?;

    Ok(ImageDimensions { width, height })
}

#[tauri::command]
pub async fn list_filesystem_roots() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let mut roots = Vec::new();
        for drive in b'A'..=b'Z' {
            let path = format!("{}:\\", drive as char);
            if Path::new(&path).exists() {
                roots.push(path);
            }
        }
        if roots.is_empty() {
            return Err("No accessible drives found".to_string());
        }
        return Ok(roots);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec!["/".to_string()])
    }
}

#[tauri::command]
pub async fn browse_filesystem(
    path: String,
    show_files: bool,
    allowed_extensions: Option<Vec<String>>,
) -> Result<FilesystemListing, String> {
    let current = PathBuf::from(&path);
    if !current.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !current.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let normalized_exts = allowed_extensions
        .unwrap_or_default()
        .into_iter()
        .map(|ext| ext.trim_start_matches('.').to_lowercase())
        .collect::<Vec<_>>();

    let mut entries = std::fs::read_dir(&current)
        .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();

            if file_type.is_dir() {
                return Some(FilesystemEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    entry_type: "folder".to_string(),
                });
            }

            if !show_files || !file_type.is_file() {
                return None;
            }

            if !normalized_exts.is_empty() {
                let ext = path.extension()?.to_string_lossy().to_lowercase();
                if !normalized_exts.iter().any(|allowed| allowed == &ext) {
                    return None;
                }
            }

            Some(FilesystemEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                entry_type: "file".to_string(),
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| match (a.entry_type.as_str(), b.entry_type.as_str()) {
        ("folder", "file") => std::cmp::Ordering::Less,
        ("file", "folder") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(FilesystemListing {
        current_path: current.to_string_lossy().into_owned(),
        parent_path: current.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}
