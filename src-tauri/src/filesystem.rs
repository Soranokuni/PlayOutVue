use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;

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

    let path_for_worker = path.clone();
    let (width, height) = tauri::async_runtime::spawn_blocking(move || {
        image::image_dimensions(&image_path)
            .map_err(|error| format!("Failed to read image dimensions '{}': {}", path_for_worker, error))
    })
    .await
    .map_err(|error| format!("Image dimensions worker failed: {}", error))??;

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
        Ok(roots)
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

    let mut dir = fs::read_dir(&current)
        .await
        .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?;
    let mut entries = Vec::new();

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| format!("Failed to iterate directory '{}': {}", path, e))?
    {
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| format!("Failed to inspect '{}' entry type: {}", entry.path().to_string_lossy(), e))?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            entries.push(FilesystemEntry {
                name,
                path: entry_path.to_string_lossy().into_owned(),
                entry_type: "folder".to_string(),
            });
            continue;
        }

        if !show_files || !file_type.is_file() {
            continue;
        }

        if !normalized_exts.is_empty() {
            let Some(ext) = entry_path.extension() else { continue; };
            let ext = ext.to_string_lossy().to_lowercase();
            if !normalized_exts.iter().any(|allowed| allowed == &ext) {
                continue;
            }
        }

        entries.push(FilesystemEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            entry_type: "file".to_string(),
        });
    }

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

/// Audit F-1: bulk existence check for rundown rows.
///
/// A row used to be discovered as broken only at TAKE, by the pre-flight check
/// inside `playItemAt` -- on air, one clip too late. The rundown fans this out
/// after every reconcile (and on drop, and at arm) so a row whose file is gone
/// is red in the list long before anyone can take it.
///
/// Keyed on the path so a virtual sub-clip, which shares its parent's
/// `current_path`, goes offline with its parent. Paths are de-duplicated by the
/// caller; each is `stat`ed once on the blocking pool.
#[tauri::command]
pub async fn verify_paths_exist(paths: Vec<String>) -> Result<std::collections::HashMap<String, bool>, String> {
    const MAX_PATHS: usize = 5_000;
    if paths.len() > MAX_PATHS {
        return Err(format!(
            "verify_paths_exist refused {} paths (limit {})",
            paths.len(),
            MAX_PATHS
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut out = std::collections::HashMap::with_capacity(paths.len());
        for path in paths {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                out.insert(path, false);
                continue;
            }
            let exists = Path::new(trimmed).is_file();
            out.insert(path, exists);
        }
        out
    })
    .await
    .map_err(|e| format!("verify_paths_exist task failed: {}", e))
}

/// Creation time (ms since the Unix epoch) of each file, for the library's
/// "Date added" sort. A mezzanine is written once by the transcoder, so its
/// creation time is its ingest time. Paths that can't be read are left out.
#[tauri::command]
pub async fn get_file_created_times(paths: Vec<String>) -> Result<std::collections::HashMap<String, i64>, String> {
    const MAX_PATHS: usize = 5_000;
    if paths.len() > MAX_PATHS {
        return Err(format!(
            "get_file_created_times refused {} paths (limit {})",
            paths.len(),
            MAX_PATHS
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut out = std::collections::HashMap::with_capacity(paths.len());
        for path in paths {
            if let Some(ms) = file_created_ms(Path::new(path.trim())) {
                out.insert(path, ms);
            }
        }
        out
    })
    .await
    .map_err(|e| format!("get_file_created_times task failed: {}", e))
}

fn file_created_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    // Some filesystems don't record a creation time; fall back to mtime.
    let time = meta.created().or_else(|_| meta.modified()).ok()?;
    let ms = time.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_ms_reads_a_real_file_and_skips_missing_ones() {
        let dir = std::env::temp_dir().join(format!("playout-ctime-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.mxf");
        std::fs::write(&file, b"x").unwrap();

        assert!(file_created_ms(&file).unwrap() > 0);
        assert!(file_created_ms(&dir.join("missing.mxf")).is_none());
        assert!(file_created_ms(&dir).is_none(), "a directory is not a file");

        std::fs::remove_dir_all(&dir).ok();
    }
}

#[derive(Serialize)]
pub struct DiskSpace {
    pub free_bytes: u64,
    pub total_bytes: u64,
    /// The directory actually queried (the nearest existing ancestor).
    pub path: String,
}

/// Free and total space of the volume holding `path`, for the library header
/// gauge. `path` may be a file or a folder that doesn't exist yet; the nearest
/// existing ancestor directory is queried.
#[tauri::command]
pub async fn get_disk_space(path: String) -> Result<DiskSpace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = nearest_existing_dir(Path::new(path.trim()))
            .ok_or_else(|| format!("No existing directory for {}", path))?;
        let (free_bytes, total_bytes) = volume_space(&dir)?;
        Ok(DiskSpace { free_bytes, total_bytes, path: dir.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| format!("get_disk_space task failed: {}", e))?
}

fn nearest_existing_dir(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    path.ancestors().find(|p| !p.as_os_str().is_empty() && p.is_dir()).map(Path::to_path_buf)
}

#[cfg(target_os = "windows")]
fn volume_space(dir: &Path) -> Result<(u64, u64), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the out pointers
    // are valid, aligned u64s on this stack frame.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut total_free) };
    if ok == 0 {
        return Err(format!("GetDiskFreeSpaceExW failed: {}", std::io::Error::last_os_error()));
    }
    // "Available to caller" honours quotas, which is what an ingest can use.
    Ok((available, total))
}

#[cfg(not(target_os = "windows"))]
fn volume_space(_dir: &Path) -> Result<(u64, u64), String> {
    Err("Disk space is only reported on Windows".to_string())
}

#[cfg(test)]
mod disk_tests {
    use super::*;

    #[test]
    fn nearest_dir_walks_up_from_a_missing_file() {
        let tmp = std::env::temp_dir();
        let missing = tmp.join("playout-no-such-dir").join("clip.mxf");
        assert_eq!(nearest_existing_dir(&missing).as_deref(), Some(tmp.as_path()));
        assert!(nearest_existing_dir(Path::new("")).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reports_space_for_the_temp_volume() {
        let (free, total) = volume_space(&std::env::temp_dir()).unwrap();
        assert!(total > 0 && free <= total);
    }
}
