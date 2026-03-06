use std::process::Command;

#[tauri::command]
pub async fn extract_web_stream(url: String) -> Result<String, String> {
    // In a production environment, yt-dlp.exe would be bundled.
    // For this demonstration, we assume it's available in the system PATH.
    
    let output = Command::new("yt-dlp")
        .arg("-g")           // Get strictly the raw stream URL (e.g., .m3u8)
        .arg("-f")
        .arg("best")       // Request maximum resolution
        .arg(&url)
        .output()
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp extraction error: {}", err_msg));
    }

    let stream_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    
    if stream_url.is_empty() {
        Err("Failed to extract a valid stream URL".into())
    } else {
        Ok(stream_url)
    }
}
