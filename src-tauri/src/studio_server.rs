use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static STUDIO_SERVER_PORT: AtomicU16 = AtomicU16::new(6258);

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

async fn handle_connection<R: Runtime>(mut stream: tokio::net::TcpStream, app: AppHandle<R>) {
    let mut buf = vec![0u8; 16384];
    let n = match stream.read(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let req_str = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req_str.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // Handle CORS Preflight
    if method == "OPTIONS" {
        let response = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, *\r\n\
Access-Control-Max-Age: 86400\r\n\
Content-Length: 0\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        return;
    }

    // Extract Body if POST
    let body = if method == "POST" {
        if let Some(pos) = req_str.find("\r\n\r\n") {
            let body_part = &req_str[pos + 4..];
            body_part.to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    match (method, path) {
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
            if !body.trim().is_empty() {
                if let Ok(preset) = serde_json::from_str::<serde_json::Value>(&body) {
                    let _ = save_default_preset_and_sync(&app, &preset).await;
                }
            }
            match crate::caspar_config::deploy_caspar_templates(app.clone(), None, None, Some(true)).await {
                Ok(deploy_res) => {
                    send_json_response(&mut stream, 200, &serde_json::json!({
                        "success": true,
                        "template_dir": deploy_res.template_dir,
                        "deployed": deploy_res.deployed
                    })).await;
                }
                Err(err) => {
                    send_json_response(&mut stream, 500, &serde_json::json!({ "success": false, "error": err })).await;
                }
            }
        }
        _ => {
            send_json_response(&mut stream, 404, &serde_json::json!({ "error": "Not Found" })).await;
        }
    }
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
Access-Control-Allow-Headers: Content-Type, *\r\n\
Content-Length: {}\r\n\r\n",
        status,
        status_text,
        json_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&json_bytes).await;
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

pub fn load_saved_default_preset<R: Runtime>(app: &AppHandle<R>) -> Option<serde_json::Value> {
    let path = get_preset_storage_path(app);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str(&content) {
                return Some(val);
            }
        }
    }

    // Check adjacent template folder
    let alt = PathBuf::from("public/templates/playout/advisory_default_preset.json");
    if alt.exists() {
        if let Ok(content) = std::fs::read_to_string(&alt) {
            if let Ok(val) = serde_json::from_str(&content) {
                return Some(val);
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

    // 2. Also save to public & assets directories if available
    let public_preset = PathBuf::from("public/templates/playout/advisory_default_preset.json");
    if let Some(parent) = public_preset.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&public_preset, &preset_json);

    let assets_preset = PathBuf::from("src/assets/templates/playout/advisory_default_preset.json");
    if let Some(parent) = assets_preset.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&assets_preset, &preset_json);

    // 3. Automatically deploy updated templates to CasparCG
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

