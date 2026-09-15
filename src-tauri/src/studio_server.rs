use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub static STUDIO_SERVER_PORT: AtomicU16 = AtomicU16::new(6258);

/// Upper bound for a request body. Presets embed SVG logos as data URIs, so
/// allow a few MB, but never let a slow-drip client grow the buffer unbounded.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Per-launch random bearer token. Every mutating route (`POST /api/*`)
/// requires `Authorization: Bearer <token>`. The token is handed to the
/// Studio page through the URL that `open_cg_studio_in_browser` opens; no
/// other origin can learn it, so a hostile web page on the operator's
/// machine cannot drive the deploy pipeline (audit T0-1).
pub fn studio_bridge_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let bytes: [u8; 32] = rand::random();
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    })
}

/// Constant-time-ish comparison of a presented bearer credential against the
/// launch token. Length mismatch short-circuits, which leaks nothing useful
/// because the token length is public.
pub fn is_authorized_bearer(authorization_header: Option<&str>, expected: &str) -> bool {
    let Some(raw) = authorization_header else { return false };
    let raw = raw.trim();
    let Some(presented) = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
    else {
        return false;
    };
    let presented = presented.trim();
    if presented.len() != expected.len() || presented.is_empty() {
        return false;
    }
    presented
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Escape a serialised JSON document so it can be embedded verbatim inside an
/// HTML `<script>` block. serde_json never escapes `<`, `>` or `&`, so a string
/// value containing `</script>` would otherwise terminate the block and inject
/// markup/JS into the on-air CG template. `\u2028`/`\u2029` are legal in JSON
/// strings but were historically line terminators in JS.
pub fn escape_json_for_script_embed(json: &str) -> String {
    let mut out = String::with_capacity(json.len() + 16);
    for ch in json.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            other => out.push(other),
        }
    }
    out
}

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
    authorization: Option<String>,
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

    // Parse Content-Length and Authorization headers
    let mut authorization: Option<String> = None;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            if let Some(val_str) = line.split(':').nth(1) {
                if let Ok(len) = val_str.trim().parse::<usize>() {
                    content_length = len;
                }
            }
        } else if lower.starts_with("authorization:") {
            if let Some(idx) = line.find(':') {
                authorization = Some(line[idx + 1..].trim().to_string());
            }
        }
    }

    if content_length > MAX_BODY_BYTES {
        return Err(format!(
            "Request body too large ({} bytes > {} limit)",
            content_length, MAX_BODY_BYTES
        ));
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
        authorization,
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
    let authorized = is_authorized_bearer(req.authorization.as_deref(), studio_bridge_token());

    // No CORS. The Studio page is served from this very origin, so browsers
    // never need cross-origin permission; advertising `Allow-Origin: *` (and
    // Private Network Access) previously let any web page call the bridge.
    if method == "OPTIONS" {
        let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        return;
    }

    let clean_path = path.split('?').next().unwrap_or(path);

    // Every mutating route requires the per-launch bearer token.
    if method == "POST" && !authorized {
        send_json_response(
            &mut stream,
            401,
            &serde_json::json!({ "success": false, "error": "Unauthorized: missing or invalid studio bridge token" }),
        )
        .await;
        return;
    }

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
            match parse_preset_body(&body) {
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
            // Deploy templates directly to CasparCG. Errors are reported
            // honestly instead of the previous unconditional `success: true`.
            let mut deployed_preset = None;
            let mut outcome: Result<(), String> = Ok(());
            if !body.trim().is_empty() {
                match parse_preset_body(&body) {
                    Ok(preset) => {
                        outcome = save_default_preset_and_sync(&app, &preset).await.map(|_| ());
                        deployed_preset = Some(preset);
                    }
                    Err(err) => {
                        send_json_response(&mut stream, 400, &serde_json::json!({ "success": false, "error": err })).await;
                        return;
                    }
                }
            }
            if deployed_preset.is_none() {
                if let Some(preset) = load_saved_default_preset(&app) {
                    outcome = save_default_preset_and_sync(&app, &preset).await.map(|_| ());
                    deployed_preset = Some(preset);
                } else {
                    outcome = crate::caspar_config::deploy_caspar_templates(app.clone(), None, None, Some(true))
                        .await
                        .map(|_| ());
                }
            }
            match outcome {
                Ok(()) => {
                    send_json_response(&mut stream, 200, &serde_json::json!({
                        "success": true,
                        "preset": deployed_preset
                    })).await;
                }
                Err(err) => {
                    send_json_response(&mut stream, 500, &serde_json::json!({
                        "success": false,
                        "error": err,
                        "preset": deployed_preset
                    })).await;
                }
            }
        }
        _ => {
            send_json_response(&mut stream, 404, &serde_json::json!({ "error": "Not Found" })).await;
        }
    }
}

async fn send_raw_response(stream: &mut tokio::net::TcpStream, status: u16, content_type: &str, body_bytes: &[u8]) {
    let status_text = http_status_text(status);
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
Content-Type: {}\r\n\
X-Content-Type-Options: nosniff\r\n\
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
    let status_text = http_status_text(status);
    let json_bytes = serde_json::to_vec(body).unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
Content-Type: application/json\r\n\
X-Content-Type-Options: nosniff\r\n\
Content-Length: {}\r\n\r\n",
        status,
        status_text,
        json_bytes.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&json_bytes).await;
}

fn http_status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    }
}

/// A preset body must be a JSON object. Arrays, scalars and `null` are
/// rejected up front so the bake step never receives a non-object.
fn parse_preset_body(body: &str) -> Result<serde_json::Value, String> {
    let value = serde_json::from_str::<serde_json::Value>(body)
        .map_err(|err| format!("Invalid JSON: {}", err))?;
    if !value.is_object() {
        return Err("Preset must be a JSON object".to_string());
    }
    Ok(value)
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
    if let Ok(raw_json) = serde_json::to_string(preset) {
        // The JSON lands inside a <script> block: escape HTML-significant
        // characters so a value like "</script><script>..." cannot break out.
        let preset_json_str = escape_json_for_script_embed(&raw_json);
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
    // Development convenience only: keep the git-tracked template copies in
    // sync while running `tauri dev`. A release build must never let an HTTP
    // request rewrite files inside the source tree / install directory.
    if !cfg!(debug_assertions) {
        return;
    }
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

    // 2. Development only: mirror into public & assets so `tauri dev` and git
    //    stay in sync. Release builds keep the preset in app-data exclusively.
    if cfg!(debug_assertions) {
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

    #[test]
    fn bake_escapes_script_breakout_in_preset_values() {
        let sample = "let BAKED_DEFAULT_PRESET = null;\n\n    const MASTER_STANDARD_PRESETS = {";
        let preset = json!({
            "id": "default",
            "fontFamily": "</script><script>alert(1)</script>",
            "customLogoSvg": "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>",
            "note": "a & b \u{2028} c"
        });
        let baked = bake_preset_into_template_content(sample, &preset);
        assert!(!baked.contains("</script>"), "script terminator must be escaped: {}", baked);
        assert!(!baked.contains("<svg"), "raw markup must be escaped: {}", baked);
        assert!(baked.contains("\\u003c/script\\u003e"));
        assert!(baked.contains("\\u0026"));
        assert!(baked.contains("\\u2028"));
        // Escaped form must still decode to the original value as JS/JSON.
        let start = baked.find("let BAKED_DEFAULT_PRESET = ").unwrap() + "let BAKED_DEFAULT_PRESET = ".len();
        let end = baked[start..].find(";\n").unwrap() + start;
        let decoded: serde_json::Value = serde_json::from_str(&baked[start..end]).expect("valid JSON");
        assert_eq!(decoded["fontFamily"], "</script><script>alert(1)</script>");
        assert_eq!(decoded["customLogoSvg"], preset["customLogoSvg"]);
    }

    #[test]
    fn bearer_authorization_requires_exact_launch_token() {
        let token = "0123456789abcdef0123456789abcdef";
        assert!(is_authorized_bearer(Some("Bearer 0123456789abcdef0123456789abcdef"), token));
        assert!(is_authorized_bearer(Some("  bearer 0123456789abcdef0123456789abcdef  "), token));
        assert!(!is_authorized_bearer(None, token));
        assert!(!is_authorized_bearer(Some(""), token));
        assert!(!is_authorized_bearer(Some("Bearer "), token));
        assert!(!is_authorized_bearer(Some("Bearer 0123456789abcdef0123456789abcdeX"), token));
        assert!(!is_authorized_bearer(Some("Bearer 0123"), token));
        assert!(!is_authorized_bearer(Some("Basic 0123456789abcdef0123456789abcdef"), token));
    }

    #[test]
    fn launch_token_is_stable_and_high_entropy() {
        let a = studio_bridge_token();
        let b = studio_bridge_token();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(a.chars().collect::<std::collections::HashSet<_>>().len() > 4);
    }

    #[test]
    fn preset_body_must_be_a_json_object() {
        assert!(parse_preset_body("{\"id\":\"x\"}").is_ok());
        assert!(parse_preset_body("[1,2]").is_err());
        assert!(parse_preset_body("null").is_err());
        assert!(parse_preset_body("\"str\"").is_err());
        assert!(parse_preset_body("{not json").is_err());
    }

    #[tokio::test]
    async fn test_read_http_request_rejects_oversized_body_declaration() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client_task = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            let headers = format!(
                "POST /api/deploy HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
                MAX_BODY_BYTES + 1
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
        });
        let (mut server_stream, _) = listener.accept().await.unwrap();
        let err = read_http_request(&mut server_stream).await.err().expect("must reject");
        assert!(err.contains("too large"));
        client_task.await.unwrap();
    }

    #[tokio::test]
    async fn test_read_http_request_captures_authorization_header() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client_task = tokio::spawn(async move {
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            let headers = "POST /api/deploy HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer abc123\r\nContent-Length: 2\r\n\r\n{}";
            stream.write_all(headers.as_bytes()).await.unwrap();
        });
        let (mut server_stream, _) = listener.accept().await.unwrap();
        let req = read_http_request(&mut server_stream).await.unwrap();
        assert_eq!(req.authorization.as_deref(), Some("Bearer abc123"));
        assert_eq!(req.body, "{}");
        client_task.await.unwrap();
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


