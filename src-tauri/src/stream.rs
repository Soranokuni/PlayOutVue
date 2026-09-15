use std::time::Duration;

/// Only http(s) URLs may be handed to yt-dlp. Anything else (a local path, a
/// `--config-locations=...` option smuggled in as the "URL", a `file:` URI)
/// is rejected before a process is spawned.
pub fn validate_stream_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty() {
        return Err("Stream URL is empty".to_string());
    }
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Stream URL must start with http:// or https://".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Stream URL contains whitespace or control characters".to_string());
    }
    Ok(trimmed)
}

#[tauri::command]
pub async fn extract_web_stream(url: String) -> Result<String, String> {
    // yt-dlp is not bundled; it is resolved from PATH by the operator's
    // environment. Audit T1-3/T2-4: bounded runtime, validated scheme, and
    // `--` so the URL can never be parsed as an option.
    let url = validate_stream_url(&url)?.to_string();

    let mut command = tokio::process::Command::new("yt-dlp");
    command
        .arg("-g") // raw stream URL only (e.g. .m3u8)
        .arg("-f")
        .arg("best")
        .arg("--")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "yt-dlp timed out after 45 s".to_string())?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_only() {
        assert!(validate_stream_url("https://example.com/live.m3u8").is_ok());
        assert!(validate_stream_url("  http://example.com/x ").is_ok());
        assert!(validate_stream_url("").is_err());
        assert!(validate_stream_url("file:///C:/x.mp4").is_err());
        assert!(validate_stream_url("C:/x.mp4").is_err());
        assert!(validate_stream_url("--config-locations=C:/evil.conf").is_err());
        assert!(validate_stream_url("rtmp://host/app").is_err());
        assert!(validate_stream_url("https://ex ample.com").is_err());
        assert!(validate_stream_url("https://example.com/\r\nX").is_err());
    }
}
