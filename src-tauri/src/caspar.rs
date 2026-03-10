use rosc::{OscPacket, OscType};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::oneshot;
use tokio::time::timeout;

const CASPAR_AMCP_ADDR: &str = "127.0.0.1:5250";
const DEFAULT_CASPAR_OSC_PORT: u16 = 6250;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
const IO_TIMEOUT: Duration = Duration::from_millis(750);
const READ_GAP_TIMEOUT: Duration = Duration::from_millis(125);
const CASPAR_ALIAS_DIR: &str = "__sota_caspar";

#[derive(Default)]
pub struct CasparOscListenerState(pub Mutex<CasparOscListenerControl>);

#[derive(Default)]
pub struct CasparOscListenerControl {
    pub port: Option<u16>,
    pub stop_tx: Option<oneshot::Sender<()>>,
    pub task: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CasparOscEvent {
    pub address: String,
    pub args: Vec<String>,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub received_at: String,
}

#[tauri::command]
pub async fn prepare_caspar_media_path(path: String, media_root: String) -> Result<String, String> {
    resolve_caspar_media_path(&path, &media_root)
}

fn resolve_caspar_media_path(path: &str, media_root: &str) -> Result<String, String> {
    let source = PathBuf::from(path.trim());
    if source.as_os_str().is_empty() {
        return Err("Empty CasparCG path".to_string());
    }

    let source_exists = source.exists();
    let source_canonical = if source_exists {
        std::fs::canonicalize(&source).unwrap_or_else(|_| source.clone())
    } else {
        source.clone()
    };

    let media_root_path = PathBuf::from(media_root.trim());
    let media_root_canonical = if media_root_path.as_os_str().is_empty() {
        None
    } else if media_root_path.exists() {
        Some(std::fs::canonicalize(&media_root_path).unwrap_or(media_root_path.clone()))
    } else {
        Some(media_root_path.clone())
    };

    if let Some(root) = media_root_canonical.as_ref() {
        if let Ok(relative) = source_canonical.strip_prefix(root) {
            let relative_str = normalize_caspar_path(relative);
            if is_caspar_safe_path(&relative_str) {
                return Ok(relative_str);
            }

            if source_exists {
                let alias_path = ensure_ascii_alias(&source_canonical, root)?;
                let alias_relative = alias_path
                    .strip_prefix(root)
                    .map_err(|error| format!("Failed to relativize CasparCG alias path: {}", error))?;
                return Ok(normalize_caspar_path(alias_relative));
            }
        }
    }

    let source_str = normalize_caspar_path(&source_canonical);
    if is_caspar_safe_path(&source_str) {
        return Ok(source_str);
    }

    if !source_exists {
        return Err(format!("CasparCG path contains unsupported characters and does not exist: {}", source_str));
    }

    let Some(root) = media_root_canonical.as_ref() else {
        return Err(format!(
            "CasparCG cannot safely access non-ASCII path '{}' without a configured media root",
            source_str
        ));
    };

    let alias_path = ensure_ascii_alias(&source_canonical, root)?;
    let alias_relative = alias_path
        .strip_prefix(root)
        .map_err(|error| format!("Failed to relativize CasparCG alias path: {}", error))?;
    Ok(normalize_caspar_path(alias_relative))
}

fn normalize_caspar_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_caspar_safe_path(path: &str) -> bool {
    path.chars().all(|ch| ch.is_ascii()) && !path.contains('"')
}

fn ensure_ascii_alias(source: &Path, media_root: &Path) -> Result<PathBuf, String> {
    let alias_dir = media_root.join(CASPAR_ALIAS_DIR);
    std::fs::create_dir_all(&alias_dir)
        .map_err(|error| format!("Failed to create CasparCG alias directory '{}': {}", alias_dir.display(), error))?;

    let source_name = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(sanitize_ascii_component)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "asset".to_string());
    let extension = source.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
    let hash = stable_hash(&normalize_caspar_path(source));
    let alias_name = if extension.is_empty() {
        format!("{}_{}", source_name, hash)
    } else {
        format!("{}_{}.{}", source_name, hash, extension)
    };
    let alias_path = alias_dir.join(alias_name);

    if alias_path.exists() {
        return Ok(alias_path);
    }

    match std::fs::hard_link(source, &alias_path) {
        Ok(()) => Ok(alias_path),
        Err(hard_link_error) => {
            std::fs::copy(source, &alias_path)
                .map_err(|copy_error| format!(
                    "Failed to create CasparCG alias for '{}' (hard link error: {}; copy error: {})",
                    source.display(),
                    hard_link_error,
                    copy_error
                ))?;
            Ok(alias_path)
        }
    }
}

fn sanitize_ascii_component(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut previous_was_separator = false;

    for ch in value.chars() {
        let keep = ch.is_ascii_alphanumeric();
        if keep {
            sanitized.push(ch.to_ascii_lowercase());
            previous_was_separator = false;
            continue;
        }

        if !previous_was_separator {
            sanitized.push('_');
            previous_was_separator = true;
        }
    }

    sanitized.trim_matches('_').chars().take(32).collect()
}

fn stable_hash(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[tauri::command]
pub async fn caspar_send_command(cmd: String) -> Result<String, String> {
    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(CASPAR_AMCP_ADDR))
        .await
        .map_err(|_| format!("Timed out connecting to CasparCG at {}", CASPAR_AMCP_ADDR))?
        .map_err(|error| format!("Failed to connect to CasparCG at {}: {}", CASPAR_AMCP_ADDR, error))?;

    let normalized = if cmd.ends_with("\r\n") {
        cmd
    } else {
        format!("{}\r\n", cmd.trim_end())
    };

    timeout(IO_TIMEOUT, stream.write_all(normalized.as_bytes()))
        .await
        .map_err(|_| "Timed out sending CasparCG command".to_string())?
        .map_err(|error| format!("Failed to send CasparCG command: {}", error))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        match timeout(READ_GAP_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => {
                response.extend_from_slice(&chunk[..read]);
                if read < chunk.len() {
                    break;
                }
            }
            Ok(Err(error)) => return Err(format!("Failed to read CasparCG response: {}", error)),
            Err(_) => break,
        }
    }

    Ok(String::from_utf8_lossy(&response).trim().to_string())
}

#[tauri::command]
pub async fn configure_caspar_osc_listener<R: Runtime>(
    port: Option<u16>,
    app: AppHandle<R>,
    state: State<'_, CasparOscListenerState>,
) -> Result<u16, String> {
    let target_port = port.unwrap_or(DEFAULT_CASPAR_OSC_PORT);
    if target_port == 0 {
        return Err("OSC port must be greater than 0".to_string());
    }

    let (existing_port, existing_stop_tx, existing_task) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Failed to lock CasparCG OSC listener state".to_string())?;

        if guard.port == Some(target_port) && guard.task.is_some() {
            return Ok(target_port);
        }

        (guard.port.take(), guard.stop_tx.take(), guard.task.take())
    };

    if let Some(stop_tx) = existing_stop_tx {
        let _ = stop_tx.send(());
    }
    if let Some(task) = existing_task {
        let _ = task.await;
    }

    let bind_addr = format!("0.0.0.0:{}", target_port);
    let socket = UdpSocket::bind(&bind_addr)
        .await
        .map_err(|error| format!("Failed to bind CasparCG OSC listener on {}: {}", bind_addr, error))?;

    let (stop_tx, stop_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(run_osc_listener(app.clone(), socket, bind_addr.clone(), stop_rx));

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Failed to lock CasparCG OSC listener state".to_string())?;
    guard.port = Some(target_port);
    guard.stop_tx = Some(stop_tx);
    guard.task = Some(task);

    if existing_port != Some(target_port) {
        app.emit(
            "caspar-osc-status",
            format!("Listening for CasparCG OSC on {}", bind_addr),
        )
        .ok();
    }

    Ok(target_port)
}

async fn run_osc_listener<R: Runtime>(
    app: AppHandle<R>,
    socket: UdpSocket,
    bind_addr: String,
    mut stop_rx: oneshot::Receiver<()>,
) {
    let mut buffer = [0_u8; 4096];

    loop {
        tokio::select! {
            _ = &mut stop_rx => {
                break;
            }
            received = socket.recv_from(&mut buffer) => {
                let Ok((size, _peer)) = received else {
                    continue;
                };

                match rosc::decoder::decode_udp(&buffer[..size]) {
                    Ok((_remainder, packet)) => {
                        for event in collect_osc_events(packet) {
                            if let Err(error) = app.emit("caspar-osc", event) {
                                eprintln!("[CasparCG] Failed to emit OSC event: {}", error);
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("[CasparCG] Failed to decode OSC packet on {}: {}", bind_addr, error);
                    }
                }
            }
        }
    }
}

fn collect_osc_events(packet: OscPacket) -> Vec<CasparOscEvent> {
    match packet {
        OscPacket::Message(message) => vec![osc_message_to_event(message.addr, message.args)],
        OscPacket::Bundle(bundle) => bundle
            .content
            .into_iter()
            .flat_map(collect_osc_events)
            .collect(),
    }
}

fn osc_message_to_event(address: String, args: Vec<OscType>) -> CasparOscEvent {
    let (position_ms, duration_ms) = parse_timing_payload(&address, &args);

    CasparOscEvent {
        address,
        args: args.iter().map(|arg| format!("{:?}", arg)).collect(),
        position_ms,
        duration_ms,
        received_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string()),
    }
}

fn parse_timing_payload(address: &str, args: &[OscType]) -> (Option<u64>, Option<u64>) {
    if !address.ends_with("/file/time") {
        return (None, None);
    }

    let seconds = args.iter().filter_map(arg_to_seconds).collect::<Vec<_>>();
    let position_ms = seconds.first().copied().map(seconds_to_millis);
    let duration_ms = seconds.get(1).copied().map(seconds_to_millis);
    (position_ms, duration_ms)
}

fn seconds_to_millis(seconds: f64) -> u64 {
    (seconds * 1000.0).round() as u64
}

fn arg_to_seconds(arg: &OscType) -> Option<f64> {
    let seconds = match arg {
        OscType::Float(value) => Some(*value as f64),
        OscType::Double(value) => Some(*value),
        OscType::Int(value) => Some(*value as f64),
        OscType::Long(value) => Some(*value as f64),
        _ => None,
    }?;

    if !seconds.is_finite() || seconds.is_sign_negative() {
        return None;
    }

    Some(seconds)
}
