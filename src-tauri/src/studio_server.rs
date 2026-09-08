use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub static STUDIO_SERVER_PORT: AtomicU16 = AtomicU16::new(6258);

#[allow(dead_code)]
pub fn get_studio_server_port() -> u16 {
    STUDIO_SERVER_PORT.load(Ordering::Relaxed)
}

pub fn start_studio_server<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let preferred_port = 6258;
        let listener = match TcpListener::bind(format!("127.0.0.1:{}", preferred_port)).await {
            Ok(l) => {
                STUDIO_SERVER_PORT.store(preferred_port, Ordering::Relaxed);
                l
            }
            Err(_) => match TcpListener::bind("127.0.0.1:6259").await {
                Ok(l) => {
                    STUDIO_SERVER_PORT.store(6259, Ordering::Relaxed);
                    l
                }
                Err(e) => {
                    eprintln!("[StudioServer] Failed to bind port 6258/6259: {}", e);
                    return;
                }
            },
        };

        let port = STUDIO_SERVER_PORT.load(Ordering::Relaxed);
        eprintln!("[StudioServer] Listening on http://127.0.0.1:{}", port);

        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app_clone = app.clone();
                    tokio::spawn(handle_connection(stream, app_clone));
                }
                Err(e) => {
                    eprintln!("[StudioServer] accept error: {}", e);
                }
            }
        }
    });
}

struct HttpRequest {
    method: String,
    path: String,
    body: String,
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    let mut header_end = None;
    let mut content_length = 0usize;

    // Phase 1: Read until headers are fully received (\r\n\r\n)
    loop {
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .map_err(|_| "Timeout reading HTTP headers".to_string())?
            .map_err(|e| format!("IO error reading HTTP headers: {}", e))?;

        if n == 0 {
            if buffer.is_empty() {
                return Err("Client closed connection immediately".to_string());
            }
            break;
        }

        buffer.extend_from_slice(&chunk[..n]);

        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = Some(pos);
            break;
        }

        if buffer.len() > 65536 {
            return Err("HTTP headers too large".to_string());
        }
    }

    let header_pos = match header_end {
        Some(pos) => pos,
        None => return Err("Incomplete HTTP headers".to_string()),
    };

    let header_str = String::from_utf8_lossy(&buffer[..header_pos]);
    let mut lines = header_str.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    // Parse Content-Length header
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            if let Some(val_str) = line.split(':').nth(1) {
                if let Ok(len) = val_str.trim().parse::<usize>() {
                    content_length = len;
                }
            }
        }
    }

    // Phase 2: Read remaining body if Content-Length > 0
    let body_start = header_pos + 4;
    let current_body_len = buffer.len().saturating_sub(body_start);
    let needed = content_length.saturating_sub(current_body_len);

    if needed > 0 {
        let mut remaining = needed;
        while remaining > 0 {
            let to_read = remaining.min(chunk.len());
            let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk[..to_read]))
                .await
                .map_err(|_| "Timeout reading HTTP body".to_string())?
                .map_err(|e| format!("IO error reading HTTP body: {}", e))?;

            if n == 0 {
                break; // EOF
            }

            buffer.extend_from_slice(&chunk[..n]);
            remaining = remaining.saturating_sub(n);
        }
    }

    let body_bytes = if content_length > 0 {
        let actual_end = (body_start + content_length).min(buffer.len());
        &buffer[body_start..actual_end]
    } else if buffer.len() > body_start {
        &buffer[body_start..]
    } else {
        &[]
    };

    let body = String::from_utf8_lossy(body_bytes).to_string();

    Ok(HttpRequest {
        method,
        path,
        body,
    })
}

async fn handle_connection<R: Runtime>(mut stream: tokio::net::TcpStream, app: AppHandle<R>) {
    let req = match read_http_request(&mut stream).await {
        Ok(r) => r,
        Err(_) => return,
    };

    let method = req.method.as_str();
    let path = req.path.as_str();
    let body = req.body;

    // Handle CORS Preflight
    if method == "OPTIONS" {
        let response = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Accept, Authorization, X-Requested-With, *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Access-Control-Max-Age: 86400\r\n\
Content-Length: 0\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        return;
    }

    let clean_path = path.split('?').next().unwrap_or(path);

    match (method, clean_path) {
        ("GET", "/studio") | ("GET", "/playout/advisory.html") => {
            let content = {
                let mut found = None;
                for cand in resolve_all_workspace_targets("public/templates/playout/advisory.html") {
                    if cand.exists() && cand.is_file() {
                        if let Ok(c) = std::fs::read_to_string(&cand) {
                            found = Some(c);
                            break;
                        }
                    }
                }
                found.unwrap_or_else(|| crate::caspar_config::TEMPLATE_ADVISORY.to_string())
            };
            let content_with_baked = if let Some(preset) = load_saved_default_preset(&app) {
                bake_preset_into_template_content(&content, &preset)
            } else {
                content
            };
            send_raw_response(&mut stream, 200, "text/html; charset=utf-8", content_with_baked.as_bytes()).await;
        }
        ("GET", "/vendor/gsap.min.js") | ("GET", "/playout/vendor/gsap.min.js") => {
            send_raw_response(&mut stream, 200, "application/javascript", crate::caspar_config::TEMPLATE_GSAP.as_bytes()).await;
        }
        ("GET", "/esr_presets.json") | ("GET", "/playout/esr_presets.json") => {
            send_raw_response(&mut stream, 200, "application/json", crate::caspar_config::TEMPLATE_ESR_PRESETS.as_bytes()).await;
        }
        ("GET", "/advisory_default_preset.json") | ("GET", "/playout/advisory_default_preset.json") => {
            if let Some(preset) = load_saved_default_preset(&app) {
                if let Ok(json_str) = serde_json::to_string_pretty(&preset) {
                    send_raw_response(&mut stream, 200, "application/json", json_str.as_bytes()).await;
                    return;
                }
            }
            send_raw_response(&mut stream, 200, "application/json", b"{}").await;
        }
        ("GET", "/api/ping") => {
            let res_body = serde_json::json!({ "ok": true, "server": "PlayOutVue Studio Bridge" });
            send_json_response(&mut stream, 200, &res_body).await;
        }
        ("GET", "/api/default-preset") => {
            let preset = load_saved_default_preset(&app);
            send_json_response(&mut stream, 200, &serde_json::json!({ "preset": preset })).await;
        }
        ("POST", "/api/save-default-preset") => {
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(preset) => {
                    let res = save_default_preset_and_sync(&app, &preset).await;
                    match res {
                        Ok(msg) => {
                            send_json_response(&mut stream, 200, &serde_json::json!({ "success": true, "message": msg })).await;
                        }
                        Err(err) => {
                            send_json_response(&mut stream, 500, &serde_json::json!({ "success": false, "error": err })).await;
                        }
                    }
                }
                Err(err) => {
                    send_json_response(&mut stream, 400, &serde_json::json!({ "success": false, "error": format!("Invalid JSON: {}", err) })).await;
                }
            }
        }
        ("POST", "/api/deploy") => {
            // Deploy templates directly to CasparCG
            let mut deployed_preset = None;
            if !body.trim().is_empty() {
                if let Ok(preset) = serde_json::from_str::<serde_json::Value>(&body) {
                    let _ = save_default_preset_and_sync(&app, &preset).await;
                    deployed_preset = Some(preset);
                }
            }
            if deployed_preset.is_none() {
                if let Some(preset) = load_saved_default_preset(&app) {
                    let _ = save_default_preset_and_sync(&app, &preset).await;
                    deployed_preset = Some(preset);
                } else {
                    let _ = crate::caspar_config::deploy_caspar_templates(app.clone(), None, None, Some(true)).await;
                }
            }
            send_json_response(&mut stream, 200, &serde_json::json!({
                "success": true,
                "preset": deployed_preset
            })).await;
        }
        _ => {
            send_json_response(&mut stream, 404, &serde_json::json!({ "error": "Not Found" })).await;
        }
    }
}

async fn send_raw_response(stream: &mut tokio::net::TcpStream, status: u16, content_type: &str, body_bytes: &[u8]) {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
Content-Type: {}\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Accept, Authorization, X-Requested-With, *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Content-Length: {}\r\n\r\n",
        status,
        status_text,
        content_type,
        body_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(body_bytes).await;
}

async fn send_json_response(stream: &mut tokio::net::TcpStream, status: u16, body: &serde_json::Value) {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let json_bytes = serde_json::to_vec(body).unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
Content-Type: application/json\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Accept, Authorization, X-Requested-With, *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Content-Length: {}\r\n\r\n",
        status,
        status_text,
        json_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&json_bytes).await;
}

pub fn resolve_all_workspace_targets(rel: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let p1 = PathBuf::from(rel);
    candidates.push(p1);
    let p2 = PathBuf::from("..").join(rel);
    candidates.push(p2);
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(rel));
            candidates.push(parent.join("..").join(rel));
            candidates.push(parent.join("..").join("..").join(rel));
        }
    }
    candidates
}

pub fn get_preset_storage_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(app_dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&app_dir);
        return app_dir.join("advisory_default_preset.json");
    }
    dirs_next::data_dir()
        .map(|d| d.join("PlayOutVue").join("advisory_default_preset.json"))
        .unwrap_or_else(|| PathBuf::from("./advisory_default_preset.json"))
}

pub fn bake_preset_into_template_content(content: &str, preset: &serde_json::Value) -> String {
    if let Ok(preset_json_str) = serde_json::to_string(preset) {
        let replacement = format!("let BAKED_DEFAULT_PRESET = {};", preset_json_str);

        // Robust statement search that handles semicolons inside JSON strings safely
        if let Some(start_idx) = content.find("let BAKED_DEFAULT_PRESET =") {
            let slice = &content[start_idx..];
            let end_offset = if let Some(idx) = slice.find("const MASTER_STANDARD_PRESETS") {
                idx
            } else if let Some(idx) = slice.find("// Broadcast standard master preset packages") {
                idx
            } else if let Some(idx) = slice.find(";\r\n") {
                idx + 1
            } else if let Some(idx) = slice.find(";\n") {
                idx + 1
            } else {
                0
            };

            if end_offset > 0 {
                let mut out = String::with_capacity(content.len() + preset_json_str.len() + 32);
                out.push_str(&content[..start_idx]);
                out.push_str(&replacement);
                out.push_str("\n\n    ");
                out.push_str(slice[end_offset..].trim_start());
                return out;
            }
        }

        // Regex fallback
        if let Ok(re) = regex::Regex::new(r"(?s)let\s+BAKED_DEFAULT_PRESET\s*=\s*.*?;(?=\s*(?://|/\*|const\s+MASTER_STANDARD_PRESETS|let\s+|function\s+))") {
            if re.is_match(content) {
                return re.replace(content, replacement.as_str()).to_string();
            }
        }
        if content.contains("let BAKED_DEFAULT_PRESET = null;") {
            return content.replace("let BAKED_DEFAULT_PRESET = null;", &replacement);
        }
    }
    content.to_string()
}

pub fn bake_preset_into_template_files(preset: &serde_json::Value) {
    let rel_targets = [
        "public/templates/playout/advisory.html",
        "src/assets/templates/playout/advisory.html",
    ];

    for rel in &rel_targets {
        for candidate in resolve_all_workspace_targets(rel) {
            if candidate.exists() && candidate.is_file() {
                if let Ok(content) = std::fs::read_to_string(&candidate) {
                    let baked = bake_preset_into_template_content(&content, preset);
                    let _ = std::fs::write(&candidate, baked);
                }
            }
        }
    }
}

pub fn load_saved_default_preset<R: Runtime>(app: &AppHandle<R>) -> Option<serde_json::Value> {
    let path = get_preset_storage_path(app);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str(&content) {
                return Some(val);
            }
        }
    }

    let rel_targets = [
        "public/templates/playout/advisory_default_preset.json",
        "src/assets/templates/playout/advisory_default_preset.json",
    ];

    for rel in &rel_targets {
        for candidate in resolve_all_workspace_targets(rel) {
            if candidate.exists() && candidate.is_file() {
                if let Ok(content) = std::fs::read_to_string(&candidate) {
                    if let Ok(val) = serde_json::from_str(&content) {
                        return Some(val);
                    }
                }
            }
        }
    }

    None
}

pub async fn save_default_preset_and_sync<R: Runtime>(
    app: &AppHandle<R>,
    preset: &serde_json::Value,
) -> Result<String, String> {
    let preset_json = serde_json::to_string_pretty(preset).map_err(|e| e.to_string())?;

    // 1. Save to App Data Directory
    let storage_path = get_preset_storage_path(app);
    if let Some(parent) = storage_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&storage_path, &preset_json)
        .map_err(|e| format!("Failed to write preset storage: {}", e))?;

    // 2. Also save to public & assets directories if available across workspace paths
    let rel_targets = [
        "public/templates/playout/advisory_default_preset.json",
        "src/assets/templates/playout/advisory_default_preset.json",
    ];

    for rel in &rel_targets {
        for candidate in resolve_all_workspace_targets(rel) {
            if let Some(parent) = candidate.parent() {
                if parent.exists() {
                    let _ = std::fs::write(&candidate, &preset_json);
                }
            }
        }
    }

    // 3. Bake preset directly into source template files so dev server and git stay in sync
    bake_preset_into_template_files(preset);

    // 4. Automatically deploy updated templates to CasparCG (which emits caspar://template-deployed)
    let _ = crate::caspar_config::deploy_caspar_templates(app.clone(), None, None, Some(true)).await;

    Ok("Default broadcast preset saved and deployed to CasparCG templates".into())
}

#[tauri::command]
pub async fn save_studio_default_preset<R: Runtime>(
    app: AppHandle<R>,
    preset: serde_json::Value,
) -> Result<String, String> {
    save_default_preset_and_sync(&app, &preset).await
}

#[tauri::command]
pub async fn get_studio_default_preset<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(load_saved_default_preset(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_bake_preset_into_template_content_initial() {
        let sample = r#"
    let currentLogoShape = 'squircle';
    let currentRatingShape = 'squircle';

    let BAKED_DEFAULT_PRESET = null;

    // Broadcast standard master preset packages
    const MASTER_STANDARD_PRESETS = {
"#;
        let preset = json!({
            "id": "default",
            "logoShape": "squircle",
            "badgeShape": "squircle",
            "fontFamily": "Outfit; -apple-system; sans-serif"
        });

        let baked = bake_preset_into_template_content(sample, &preset);
        assert!(baked.contains("let BAKED_DEFAULT_PRESET = {\"badgeShape\":\"squircle\",\"fontFamily\":\"Outfit; -apple-system; sans-serif\",\"id\":\"default\",\"logoShape\":\"squircle\"};"));
        assert!(baked.contains("const MASTER_STANDARD_PRESETS = {"));
        assert!(!baked.contains("BAKED_DEFAULT_PRESET = null;"));
    }

    #[test]
    fn test_bake_preset_into_template_content_overwrite_existing() {
        let sample = r#"
    let currentLogoShape = 'circle';
    let currentRatingShape = 'circle';

    let BAKED_DEFAULT_PRESET = {"id":"default","badgeShape":"circle","logoShape":"circle"};

    // Broadcast standard master preset packages
    const MASTER_STANDARD_PRESETS = {
"#;
        let preset = json!({
            "id": "default",
            "logoShape": "squircle",
            "badgeShape": "squircle"
        });

        let baked = bake_preset_into_template_content(sample, &preset);
        assert!(baked.contains("let BAKED_DEFAULT_PRESET = {\"badgeShape\":\"squircle\",\"id\":\"default\",\"logoShape\":\"squircle\"};"));
        assert!(baked.contains("const MASTER_STANDARD_PRESETS = {"));
        assert!(!baked.contains("\"badgeShape\":\"circle\""));
    }

    #[test]
    fn test_bake_preset_into_template_content_tolerates_semicolons_in_json_values() {
        let sample = r#"
    let currentLogoShape = 'squircle';

    let BAKED_DEFAULT_PRESET = null;

    const MASTER_STANDARD_PRESETS = {
"#;
        let preset = json!({
            "id": "default",
            "fontFamily": "font-family: 'Outfit'; font-size: 14px;",
            "dataUri": "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http..."
        });

        let baked = bake_preset_into_template_content(sample, &preset);
        assert!(baked.contains("let BAKED_DEFAULT_PRESET = {"));
        assert!(baked.contains("data:image/svg+xml;charset=utf-8"));
        assert!(baked.contains("const MASTER_STANDARD_PRESETS = {"));
    }

    #[tokio::test]
    async fn test_read_http_request_chunked_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let client_task = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            // Send headers first
            let headers = "POST /api/deploy HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 18\r\n\r\n";
            stream.write_all(headers.as_bytes()).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            // Send body in separate TCP write
            let body = "{\"shape\":\"circle\"}";
            stream.write_all(body.as_bytes()).await.unwrap();
        });

        let (mut server_stream, _) = listener.accept().await.unwrap();
        let req = read_http_request(&mut server_stream).await.unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/api/deploy");
        assert_eq!(req.body, "{\"shape\":\"circle\"}");

        client_task.await.unwrap();
    }
}


