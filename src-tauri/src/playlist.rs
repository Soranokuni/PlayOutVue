#[tauri::command]
pub async fn save_playlist(path: String, json: String) -> Result<(), String> {
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to save playlist to '{}': {}", path, e))
}

#[tauri::command]
pub async fn load_playlist(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to load playlist from '{}': {}", path, e))
}
