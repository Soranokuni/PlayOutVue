use std::path::PathBuf;

/// Persist a rundown. Audit T1-5: the previous `std::fs::write` over the
/// live file could leave a truncated JSON on power loss with no recovery
/// copy. Now atomic (tmp + fsync + rename) with a `<name>.bak` of the prior
/// version, and off the async runtime.
#[tauri::command]
pub async fn save_playlist(path: String, json: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        crate::atomic_fs::write_atomic_with_backup(&target, json.as_bytes())
            .map(|_| ())
            .map_err(|e| format!("Failed to save playlist to '{}': {}", target.display(), e))
    })
    .await
    .map_err(|e| format!("Playlist save task failed: {}", e))?
}

#[tauri::command]
pub async fn load_playlist(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&target)
            .map_err(|e| format!("Failed to load playlist from '{}': {}", target.display(), e))
    })
    .await
    .map_err(|e| format!("Playlist load task failed: {}", e))?
}
