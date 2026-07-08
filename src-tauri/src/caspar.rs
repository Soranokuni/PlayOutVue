use rosc::{OscPacket, OscType};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::net::UdpSocket;
use tokio::sync::oneshot;

use crate::amcp::AmcpClient;
use crate::caspar_layers::CasparLayer;

const DEFAULT_CASPAR_OSC_PORT: u16 = 6250;
const CASPAR_ALIAS_DIR: &str = "__sota_caspar";

#[derive(Default)]
pub struct CasparOscListenerState(pub Mutex<CasparOscListenerControl>);

#[derive(Default)]
pub struct CasparOscListenerControl {
    pub port: Option<u16>,
    pub stop_tx: Option<oneshot::Sender<()>>,
    pub task: Option<JoinHandle<()>>,
    pub watchdog_task: Option<JoinHandle<()>>,
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
    tauri::async_runtime::spawn_blocking(move || resolve_caspar_media_path(&path, &media_root))
        .await
        .map_err(|error| format!("CasparCG path worker failed: {}", error))?
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

    // ── Attempt 1: canonical strip_prefix (the happy path) ──
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

    // ── Attempt 2: case-insensitive, separator-agnostic string strip ──
    // This handles the common failure case where the source path was not
    // canonicalised (file not found, network share, etc.) and therefore
    // strip_prefix on the Path fails even though the media root prefix is
    // present.  We normalise both to forward-slash + lowercase and compare.
    if let Some(root) = media_root_canonical.as_ref().or(media_root_path.exists().then(|| &media_root_path)) {
        if let Some(relative_str) = try_string_strip_prefix(&source, root) {
            if is_caspar_safe_path(&relative_str) {
                return Ok(relative_str);
            }
        }

        // ── Attempt 3: try to locate the file relative to the media root ──
        // If the source path is just a filename or a partial path, try
        // joining it with the media root to see if the file exists there.
        if !source_exists {
            let file_name = source.file_name();
            if let Some(name) = file_name {
                let candidate = media_root_path.join(name);
                if candidate.exists() {
                    let candidate_canonical = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
                    if let Ok(relative) = candidate_canonical.strip_prefix(
                        media_root_canonical.as_ref().unwrap_or(&media_root_path)
                    ) {
                        let relative_str = normalize_caspar_path(relative);
                        if is_caspar_safe_path(&relative_str) {
                            return Ok(relative_str);
                        }
                    }
                }

                // Also try searching subdirectories one level deep (e.g. videos/)
                if let Ok(entries) = std::fs::read_dir(&media_root_path) {
                    for entry in entries.flatten() {
                        if !entry.path().is_dir() { continue; }
                        let subdir_candidate = entry.path().join(name);
                        if subdir_candidate.exists() {
                            let subdir_canonical = std::fs::canonicalize(&subdir_candidate)
                                .unwrap_or_else(|_| subdir_candidate.clone());
                            if let Ok(relative) = subdir_canonical.strip_prefix(
                                media_root_canonical.as_ref().unwrap_or(&media_root_path)
                            ) {
                                let relative_str = normalize_caspar_path(relative);
                                if is_caspar_safe_path(&relative_str) {
                                    return Ok(relative_str);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Attempt 4: if the source path is already a safe relative path, return it ──
    let source_str = normalize_caspar_path(&source_canonical);
    if is_caspar_safe_path(&source_str) && !source_str.contains(':') && !source_str.starts_with("/") {
        // Only return as-is if it's a relative path (no drive letter, no leading /)
        return Ok(source_str);
    }

    // ── Attempt 5: non-ASCII path with existing file → create alias ──
    if !source_exists {
        return Err(format!(
            "CasparCG media file not found at '{}' (media root: '{}'). \
             Verify the file exists and the media path is configured correctly.",
            source_str,
            normalize_caspar_path(&media_root_path)
        ));
    }

    let Some(root) = media_root_canonical.as_ref().or(Some(&media_root_path)) else {
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

/// Case-insensitive, separator-agnostic prefix stripping.
/// Normalises both paths to forward slashes and lowercase, then checks if
/// the source starts with the media root.  If so, returns the relative
/// portion (preserving the original casing of the source).
fn try_string_strip_prefix(source: &Path, media_root: &Path) -> Option<String> {
    let source_str = source.to_string_lossy().replace('\\', "/");
    let root_str = media_root.to_string_lossy().replace('\\', "/");

    // Strip Windows verbatim prefix from both
    let source_clean = strip_verbatim_prefix(&source_str);
    let root_clean = strip_verbatim_prefix(&root_str);

    let root_trimmed = root_clean.trim_end_matches('/');

    if root_trimmed.is_empty() {
        return None;
    }

    let source_lower = source_clean.to_lowercase();
    let root_lower = root_trimmed.to_lowercase();

    if source_lower.starts_with(&root_lower) {
        let relative = &source_clean[root_trimmed.len()..];
        let relative_trimmed = relative.trim_start_matches('/');
        if relative_trimmed.is_empty() {
            return None;
        }
        return Some(relative_trimmed.to_string());
    }

    None
}

fn strip_verbatim_prefix(path: &str) -> &str {
    if path.starts_with("//?/") {
        &path[4..]
    } else if path.starts_with(r"\\?\") {
        &path[4..]
    } else {
        path
    }
}

fn normalize_caspar_path(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if s.starts_with("//?/") {
        s = s[4..].to_string();
    }
    s
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
pub async fn caspar_send_command(
    cmd: String,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

#[tauri::command]
pub async fn configure_caspar_osc_listener<R: Runtime>(
    port: Option<u16>,
    app: AppHandle<R>,
    state: State<'_, CasparOscListenerState>,
    playback: State<'_, CasparPlaybackState>,
) -> Result<u16, String> {
    let target_port = port.unwrap_or(DEFAULT_CASPAR_OSC_PORT);
    if target_port == 0 {
        return Err("OSC port must be greater than 0".to_string());
    }

    let (existing_port, existing_stop_tx, existing_task, existing_watchdog) = {
        let mut guard = state.0.lock();

        if guard.port == Some(target_port) && guard.task.is_some() {
            return Ok(target_port);
        }

        (guard.port.take(), guard.stop_tx.take(), guard.task.take(), guard.watchdog_task.take())
    };

    if let Some(stop_tx) = existing_stop_tx {
        let _ = stop_tx.send(());
    }
    if let Some(task) = existing_task {
        let _ = task.await;
    }
    if let Some(watchdog) = existing_watchdog {
        watchdog.abort();
    }

    let bind_addr = format!("0.0.0.0:{}", target_port);
    let socket = UdpSocket::bind(&bind_addr)
        .await
        .map_err(|error| format!("Failed to bind CasparCG OSC listener on {}: {}", bind_addr, error))?;

    let (stop_tx, stop_rx) = oneshot::channel();
    let playback_state = playback.0.clone();
    let watchdog = spawn_playback_watchdog(app.clone(), playback_state.clone());
    let task = tauri::async_runtime::spawn(run_osc_listener(
        app.clone(),
        socket,
        bind_addr.clone(),
        stop_rx,
        playback_state,
    ));

    let mut guard = state.0.lock();
    guard.port = Some(target_port);
    guard.stop_tx = Some(stop_tx);
    guard.task = Some(task);
    guard.watchdog_task = Some(watchdog);

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
    playback_state: Arc<Mutex<PlaybackStateInner>>,
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
                        process_decoded_packet(&app, packet, &playback_state);
                    }
                    Err(error) => {
                        eprintln!("[CasparCG] Failed to decode OSC packet on {}: {}", bind_addr, error);
                    }
                }
            }
        }
    }
}

fn process_decoded_packet<R: Runtime>(
    app: &AppHandle<R>,
    packet: OscPacket,
    playback_state: &Arc<Mutex<PlaybackStateInner>>,
) {
    match packet {
        OscPacket::Message(message) => {
            let address = message.addr;
            let args = message.args;

            if is_program_file_path_address(&address) {
                if let Some(OscType::String(path)) = args.first() {
                    handle_playback_path_osc(app, playback_state, path);
                }
            } else if is_program_file_time_address(&address) {
                let (position_ms, duration_ms) = parse_timing_payload_from_args(&args);
                handle_playback_osc(app, playback_state, position_ms, duration_ms);
            }

            let event = osc_message_to_event_from_raw(address, args);
            if let Err(error) = app.emit("caspar-osc", event) {
                eprintln!("[CasparCG] Failed to emit OSC event: {}", error);
            }
        }
        OscPacket::Bundle(bundle) => {
            for content in bundle.content {
                process_decoded_packet(app, content, playback_state);
            }
        }
    }
}

fn osc_message_to_event_from_raw(address: String, args: Vec<OscType>) -> CasparOscEvent {
    let (position_ms, duration_ms) = parse_timing_payload_from_args(&args);

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

fn parse_timing_payload_from_args(args: &[OscType]) -> (Option<u64>, Option<u64>) {
    if args.len() == 4 {
        let position_ms = arg_to_float(&args[2]).map(seconds_to_millis);
        let duration_ms = arg_to_float(&args[3]).map(seconds_to_millis);
        (position_ms, duration_ms)
    } else {
        let seconds = args.iter().filter_map(arg_to_float).collect::<Vec<_>>();
        let position_ms = seconds.first().copied().map(seconds_to_millis);
        let duration_ms = seconds.get(1).copied().map(seconds_to_millis);
        (position_ms, duration_ms)
    }
}

fn normalize_caspar_osc_path(path: &str) -> String {
    let mut p = path.replace('\\', "/").to_lowercase();
    if p.starts_with("//?/") {
        p = p[4..].to_string();
    }
    p = p.trim_matches(|c| c == '/' || c == '"' || c == ' ').to_string();
    if let Some(pos) = p.rfind('.') {
        let ext = &p[pos + 1..];
        if ext.len() >= 3 && ext.len() <= 4 {
            p = p[..pos].to_string();
        }
    }
    p
}

fn is_program_file_path_address(address: &str) -> bool {
    let normalized = address.trim();
    normalized == "/channel/1/stage/layer/10/file/path"
        || normalized == "/channel/1/stage/layer/10/foreground/file/path"
}

fn extract_raw_filename_lower(path_str: &str) -> String {
    let mut cleaned = path_str.replace('\\', "/");
    if cleaned.starts_with("//?/") {
        cleaned = cleaned[4..].to_string();
    } else if cleaned.starts_with("\\\\?\\") {
        cleaned = cleaned[4..].to_string();
    }
    if cleaned.len() >= 2 && cleaned.chars().nth(1) == Some(':') {
        cleaned = cleaned[2..].to_string();
    }
    let p = std::path::Path::new(&cleaned);
    let filename = p.file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(&cleaned);
    let mut filename_lower = filename.to_lowercase();
    if let Some(pos) = filename_lower.rfind('.') {
        let ext = &filename_lower[pos + 1..];
        if ext.len() >= 3 && ext.len() <= 4 {
            filename_lower = filename_lower[..pos].to_string();
        }
    }
    filename_lower
}

fn handle_playback_path_osc<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<Mutex<PlaybackStateInner>>,
    path: &str,
) {
    let mut s = state.lock();
    if !s.is_playing || s.is_paused {
        return;
    }

    let normalized_path = normalize_caspar_osc_path(path);
    s.current_file_path = normalized_path.clone();

    if let Some(expected) = &s.expected_next_path {
        let path_norm = extract_raw_filename_lower(path);
        let expected_norm = extract_raw_filename_lower(expected);
        if path_norm == expected_norm {
            if !s.transition_triggered {
                s.transition_triggered = true;
                s.advance_fired = true; // Sync the advance fired flag to prevent double-trigger
                s.expected_next_path = None; // Clear the expected next path state to avoid deadlock

                let advance = PlaybackAdvance {
                    current_uuid: s.current_uuid.clone(),
                    reason: "osc-path-switch".to_string(),
                };
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app_clone.emit("caspar://advance", advance);
                });
            }
        }
    }
}

fn is_program_file_time_address(address: &str) -> bool {
    let normalized = address.trim();
    normalized == "/channel/1/stage/layer/10/file/time"
        || normalized == "/channel/1/stage/layer/10/foreground/file/time"
}

fn seconds_to_millis(seconds: f64) -> u64 {
    (seconds * 1000.0).round() as u64
}

fn arg_to_float(arg: &OscType) -> Option<f64> {
    let seconds = match arg {
        OscType::Float(value) => Some(*value as f64),
        OscType::Double(value) => Some(*value),
        _ => None,
    }?;

    if !seconds.is_finite() || seconds.is_sign_negative() {
        return None;
    }

    Some(seconds)
}

// ---------------------------------------------------------------------------
// OSC-authoritative playback state machine (plan §2.1)
// ---------------------------------------------------------------------------

/// Advance fires when position is within this many ms of duration.
const ADVANCE_THRESHOLD_MS: u64 = 200;
/// Throttle `caspar://playback-tick` to at most one emission per this interval.
const TICK_THROTTLE_MS: u64 = 100;
/// If no OSC packet arrives for this long while playing, the watchdog emits
/// `caspar://stalled` and arms a deadline fallback (plan §2.1).
const PLAYBACK_WATCHDOG_MS: u64 = 3000;
/// Watchdog tick cadence.
const WATCHDOG_TICK_MS: u64 = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTick {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub current_uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackAdvance {
    pub current_uuid: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStalled {
    pub current_uuid: Option<String>,
    pub gap_ms: u64,
}

/// Authoritative playback state, owned by Rust and updated from OSC.
pub struct PlaybackStateInner {
    pub current_uuid: Option<String>,
    pub is_playing: bool,
    pub is_paused: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub expected_out_point_ms: u64,
    pub current_file_path: String,
    pub expected_next_path: Option<String>,
    pub last_osc_at_ms: u64,
    pub last_tick_emit_ms: u64,
    pub advance_fired: bool,
    pub stall_emitted: bool,
    pub transition_triggered: bool,
    /// Previous OSC position, used to detect position stalls (EOF freeze).
    pub last_position_ms: u64,
    /// Consecutive watchdog ticks where the position has not advanced.
    pub position_stalled_ticks: u32,
    /// Whether the position has advanced at least once since playback started.
    /// Used to distinguish a startup delay from a genuine EOF stall.
    pub position_ever_advanced: bool,
}

impl Default for PlaybackStateInner {
    fn default() -> Self {
        PlaybackStateInner {
            current_uuid: None,
            is_playing: false,
            is_paused: false,
            position_ms: 0,
            duration_ms: 0,
            expected_out_point_ms: u64::MAX,
            current_file_path: String::new(),
            expected_next_path: None,
            last_osc_at_ms: 0,
            last_tick_emit_ms: 0,
            advance_fired: false,
            stall_emitted: false,
            transition_triggered: false,
            last_position_ms: 0,
            position_stalled_ticks: 0,
            position_ever_advanced: false,
        }
    }
}

/// Tauri-managed wrapper around the authoritative playback state.
#[derive(Clone, Default)]
pub struct CasparPlaybackState(pub Arc<Mutex<PlaybackStateInner>>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pure advance decision (plan §2.1 / §5): exactly one advance per item.
/// Fires when within `ADVANCE_THRESHOLD_MS` of the end, but never when paused or
/// once already fired. Extracted for unit testing the state-machine invariants.
pub fn playback_should_advance(
    is_playing: bool,
    is_paused: bool,
    advance_fired: bool,
    expected_out_point_ms: u64,
    position_ms: u64,
) -> bool {
    is_playing
        && !is_paused
        && !advance_fired
        && position_ms > 0
        && expected_out_point_ms > 0
        && position_ms >= expected_out_point_ms.saturating_sub(ADVANCE_THRESHOLD_MS)
}

/// Update playback state from a program-layer `/file/time` OSC message and emit
/// the throttled tick / single advance events (plan §2.1). Called from the OSC
/// listener loop.
fn handle_playback_osc<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<Mutex<PlaybackStateInner>>,
    position_ms: Option<u64>,
    duration_ms: Option<u64>,
) {
    let now = now_ms();
    let mut s = state.lock();
    if !s.is_playing || s.is_paused {
        return;
    }

    if let Some(pos) = position_ms {
        s.position_ms = pos;
    }
    if let Some(dur) = duration_ms {
        if dur > 0 && (s.expected_out_point_ms == 0 || s.expected_out_point_ms == u64::MAX || (dur as i64 - s.expected_out_point_ms as i64).abs() < 5000) {
            s.duration_ms = dur;
        }
    }
    s.last_osc_at_ms = now;

    // Track position stalls for EOF freeze detection. When the producer
    // hits EOF before the expected out point (e.g. due to an inflated DB
    // duration causing a LENGTH larger than the remaining frames), the
    // OSC position stops advancing while OSC packets keep arriving.
    if position_ms.is_some() {
        if s.position_ms > s.last_position_ms + 40 {
            s.position_ever_advanced = true;
            s.position_stalled_ticks = 0;
        } else if s.position_ever_advanced && s.position_ms == s.last_position_ms {
            s.position_stalled_ticks += 1;
        }
        s.last_position_ms = s.position_ms;
    }

    // Position-based advance check (primary advance mechanism)
    if playback_should_advance(
        s.is_playing,
        s.is_paused,
        s.advance_fired,
        s.expected_out_point_ms,
        s.position_ms,
    ) {
        s.advance_fired = true;
        s.transition_triggered = true;
        let advance = PlaybackAdvance {
            current_uuid: s.current_uuid.clone(),
            reason: "osc-position".to_string(),
        };
        let app_clone = app.clone();
        drop(s); // release lock before emit to prevent deadlocks
        tauri::async_runtime::spawn(async move {
            let _ = app_clone.emit("caspar://advance", advance);
        });
        return;
    }

    // Throttled tick emission.
    if now.saturating_sub(s.last_tick_emit_ms) >= TICK_THROTTLE_MS {
        s.last_tick_emit_ms = now;
        let tick = PlaybackTick {
            position_ms: s.position_ms,
            duration_ms: s.duration_ms,
            current_uuid: s.current_uuid.clone(),
        };
        let app_clone = app.clone();
        let payload = tick;
        tauri::async_runtime::spawn(async move {
            let _ = app_clone.emit("caspar://playback-tick", payload);
        });
    }
}

/// Spawn the watchdog task that detects OSC stalls and arms a deadline
/// fallback advance so a CasparCG OSC freeze cannot hang the rundown. Spawned
/// once from `configure_caspar_osc_listener` (which owns a concrete
/// `AppHandle<R>`); the task reads the shared playback state thereafter.
pub fn spawn_playback_watchdog<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<Mutex<PlaybackStateInner>>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(WATCHDOG_TICK_MS)).await;
            let now = now_ms();
            let (emit_stall, emit_advance_reason) = {
                let mut s = state.lock();
                if !s.is_playing || s.is_paused || s.current_uuid.is_none() || s.advance_fired {
                    continue;
                }
                let gap = now.saturating_sub(s.last_osc_at_ms);
                let mut stall = false;
                let mut advance_reason = None;
                if gap >= PLAYBACK_WATCHDOG_MS {
                    if !s.stall_emitted {
                        s.stall_emitted = true;
                        stall = true;
                    }
                    // Deadline fallback: once stalled, advance when the estimated
                    // remaining playback time (from last known position) elapses.
                    let remaining = if s.expected_out_point_ms == u64::MAX {
                        u64::MAX
                    } else {
                        s.expected_out_point_ms.saturating_sub(s.position_ms)
                    };
                    let deadline = if remaining == u64::MAX {
                        u64::MAX
                    } else {
                        s.last_osc_at_ms.saturating_add(remaining)
                    };
                    if deadline != u64::MAX && now >= deadline {
                        s.advance_fired = true;
                        s.transition_triggered = true;
                        advance_reason = Some("watchdog-deadline".to_string());
                    }
                } else if gap >= 1500 {
                    // Brief OSC gap — only advance if position was already near the end (EOF)
                    if s.position_ms > 0
                        && s.expected_out_point_ms > 0
                        && s.expected_out_point_ms != u64::MAX
                        && s.position_ms >= s.expected_out_point_ms.saturating_sub(2000)
                    {
                        s.advance_fired = true;
                        s.transition_triggered = true;
                        advance_reason = Some("eof-watchdog".to_string());
                    }
                }

                // Position-stall EOF detection: OSC packets are still arriving
                // (gap < 1500) but the position has not advanced for several
                // ticks. This catches the case where the producer hits EOF
                // before the expected out point — e.g. when the DB duration is
                // inflated (ffprobe picking the max stream duration instead of
                // the video duration), causing compute_frame_trim to produce a
                // LENGTH larger than the remaining frames. CasparCG plays to
                // EOF, the position freezes, but the watchdog's deadline is
                // set far in the future. Without this check the rundown would
                // freeze for the entire inflated duration.
                if advance_reason.is_none()
                    && s.position_ever_advanced
                    && s.position_stalled_ticks >= 12
                    && s.position_ms > 500
                {
                    s.advance_fired = true;
                    s.transition_triggered = true;
                    advance_reason = Some("eof-position-stall".to_string());
                }
                (stall, advance_reason)
            };

            if emit_stall {
                let (uuid, gap) = {
                    let s = state.lock();
                    (s.current_uuid.clone(), now_ms().saturating_sub(s.last_osc_at_ms))
                };
                let _ = app.emit(
                    "caspar://stalled",
                    PlaybackStalled {
                        current_uuid: uuid,
                        gap_ms: gap,
                    },
                );
            }
            if let Some(reason) = emit_advance_reason {
                let uuid = state.lock().current_uuid.clone();
                let _ = app.emit(
                    "caspar://advance",
                    PlaybackAdvance {
                        current_uuid: uuid,
                        reason,
                    },
                );
            }
        }
    })
}

/// Register the current item with the Rust state machine; Rust then owns advance.
#[tauri::command]
pub async fn caspar_register_playback(
    uuid: String,
    duration_ms: u64,
    expected_out_point_ms: u64,
    current_path: String,
    next_path: Option<String>,
    state: State<'_, CasparPlaybackState>,
) -> Result<(), String> {
    let mut s = state.0.lock();
    s.current_uuid = Some(uuid);
    s.is_playing = true;
    s.is_paused = false;
    s.position_ms = 0;
    s.duration_ms = duration_ms;

    let mut out_point = expected_out_point_ms;
    if out_point == 0 {
        if duration_ms == 0 {
            out_point = u64::MAX;
        } else {
            out_point = duration_ms;
        }
    }
    s.expected_out_point_ms = out_point;

    s.current_file_path = current_path;
    s.expected_next_path = next_path;
    s.last_osc_at_ms = now_ms();
    s.last_tick_emit_ms = 0;
    s.advance_fired = false;
    s.stall_emitted = false;
    s.transition_triggered = false;
    s.last_position_ms = 0;
    s.position_stalled_ticks = 0;
    s.position_ever_advanced = false;
    Ok(())
}

/// Toggle the paused state. When paused, the watchdog and OSC EOF advance are
/// suppressed so a frozen producer does not trigger a spurious advance.
#[tauri::command]
pub async fn caspar_set_playback_paused(
    paused: bool,
    state: State<'_, CasparPlaybackState>,
) -> Result<(), String> {
    let mut s = state.0.lock();
    if paused {
        s.is_paused = true;
    } else {
        s.is_paused = false;
        // Resuming: reset the OSC clock so the watchdog doesn't immediately fire
        // based on the stale pre-pause timestamp.
        s.last_osc_at_ms = now_ms();
    }
    Ok(())
}

/// Clear playback state (called by Vue stop()/advance-to-end).
#[tauri::command]
pub async fn caspar_clear_playback(state: State<'_, CasparPlaybackState>) -> Result<(), String> {
    let mut s = state.0.lock();
    s.current_uuid = None;
    s.is_playing = false;
    s.is_paused = false;
    s.position_ms = 0;
    s.duration_ms = 0;
    s.expected_out_point_ms = u64::MAX;
    s.current_file_path = String::new();
    s.expected_next_path = None;
    s.advance_fired = false;
    s.stall_emitted = false;
    s.transition_triggered = false;
    s.last_position_ms = 0;
    s.position_stalled_ticks = 0;
    s.position_ever_advanced = false;
    Ok(())
}

// ---------------------------------------------------------------------------
// Typed AMCP Tauri commands (plan §1.3)
// ---------------------------------------------------------------------------

/// Add a CG template to a layer with a JSON payload (serde-serialized, fixing
/// the broken hand-rolled `escapeJson`).
#[tauri::command]
pub async fn caspar_cg_add(
    channel: u8,
    layer: u16,
    template: String,
    play: bool,
    data: serde_json::Value,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let data_str = serde_json::to_string(&data).map_err(|e| format!("CG payload serialize: {}", e))?;
    let cmd = crate::amcp::cg_add_cmd(channel, layer, 1, &template, play, &data_str);
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

/// Update a CG template's data (live, e.g. crawl text).
#[tauri::command]
pub async fn caspar_cg_update(
    channel: u8,
    layer: u16,
    data: serde_json::Value,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let data_str = serde_json::to_string(&data).map_err(|e| format!("CG payload serialize: {}", e))?;
    let cmd = crate::amcp::cg_update_cmd(channel, layer, 1, &data_str);
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

/// Play a previously-added CG template.
#[tauri::command]
pub async fn caspar_cg_play(
    channel: u8,
    layer: u16,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let cmd = crate::amcp::cg_play_cmd(channel, layer, 1);
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

/// Stop a CG template.
#[tauri::command]
pub async fn caspar_cg_stop(
    channel: u8,
    layer: u16,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let cmd = crate::amcp::cg_stop_cmd(channel, layer, 1);
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

/// Typed image producer: `PLAY <ch>-<layer> "<path>"`.
#[tauri::command]
pub async fn caspar_play_image(
    channel: u8,
    layer: u16,
    path: String,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let cmd = crate::amcp::play_image_cmd(channel, layer, &path);
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

/// Targeted clear of a single layer: `CLEAR <ch>-<layer>`.
#[tauri::command]
pub async fn caspar_clear_layer(
    channel: u8,
    layer: u16,
    client: State<'_, AmcpClient>,
) -> Result<String, String> {
    let cmd = crate::amcp::clear_layer_cmd(channel, layer);
    let resp = client.send(&cmd).await?;
    Ok(resp.body)
}

/// Helper used by Rust-side audit logging: assert no MIXER FILL is ever sent to
/// CG template layers 32/33. Returns true if the layer is safe for MIXER.
#[allow(dead_code)]
pub fn mixer_safe_for_layer(layer: u16) -> bool {
    CasparLayer::from_layer(layer)
        .map(|l| l.supports_mixer())
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Advance fires exactly once near EOF and not before (plan §5 state machine).
    #[test]
    fn advance_fires_once_near_eof() {
        // Mid-playback: no advance.
        assert!(!playback_should_advance(true, false, false, 10_000, 5_000));
        // Just before threshold: no advance.
        assert!(!playback_should_advance(true, false, false, 10_000, 10_000 - ADVANCE_THRESHOLD_MS - 1));
        // Within threshold: advance.
        assert!(playback_should_advance(true, false, false, 10_000, 10_000 - ADVANCE_THRESHOLD_MS));
        // At/over end: advance.
        assert!(playback_should_advance(true, false, false, 10_000, 10_000));

        // Guard: once fired, never again (exactly one advance per item).
        assert!(!playback_should_advance(true, false, true, 10_000, 10_000));
    }

    /// Paused playback never advances (prevents the watchdog from advancing a
    /// frozen producer — the pause-flag fix).
    #[test]
    fn paused_never_advances() {
        assert!(!playback_should_advance(true, true, false, 10_000, 10_000));
    }

    /// No duration (unknown) -> no advance via OSC EOF; the watchdog deadline
    /// handles the fallback path instead (plan §2.1).
    #[test]
    fn unknown_duration_no_osc_advance() {
        assert!(!playback_should_advance(true, false, false, 0, 0));
    }

    /// mixer_safe_for_layer enforces no MIXER FILL on CG template layers 32/33
    /// (plan §1.1 rule / §5 audit assertion).
    #[test]
    fn mixer_forbidden_on_template_layers() {
        assert!(!mixer_safe_for_layer(CasparLayer::Explanation.layer()));
        assert!(!mixer_safe_for_layer(CasparLayer::Crawl.layer()));
        // Image layers allow MIXER.
        assert!(mixer_safe_for_layer(CasparLayer::StationLogo.layer()));
        assert!(mixer_safe_for_layer(CasparLayer::Rating.layer()));
        assert!(mixer_safe_for_layer(CasparLayer::Tp.layer()));
        // Program/live layers: MIXER is not applied by the CG path.
        assert!(!mixer_safe_for_layer(CasparLayer::Video.layer()));
        assert!(!mixer_safe_for_layer(CasparLayer::Live.layer()));
    }

    /// Verify that is_program_file_time_address only matches layer 10 OSC addresses.
    #[test]
    fn is_program_file_time_address_filters_correctly() {
        // Valid layer 10 addresses
        assert!(is_program_file_time_address("/channel/1/stage/layer/10/file/time"));
        assert!(is_program_file_time_address("/channel/1/stage/layer/10/foreground/file/time"));
        assert!(is_program_file_time_address("  /channel/1/stage/layer/10/file/time  ")); // trim check

        // Invalid addresses (other layers or channel-level)
        assert!(!is_program_file_time_address("/channel/1/foreground/file/time"));
        assert!(!is_program_file_time_address("/channel/1/stage/layer/30/foreground/file/time"));
        assert!(!is_program_file_time_address("/channel/2/stage/layer/10/file/time"));
        assert!(!is_program_file_time_address("/channel/1/stage/layer/10/some/other/path"));
    }

    /// Verify parse_timing_payload_from_args correctly extracts values for 4-argument,
    /// 2-argument, and fallback structures.
    #[test]
    fn parse_timing_payload_from_args_extracts_correctly() {
        use rosc::OscType;

        // 4 arguments: [current_frame, total_frames, current_seconds, total_seconds]
        let args_4 = vec![
            OscType::Int(1127),
            OscType::Int(9246),
            OscType::Float(45.08),
            OscType::Float(369.84),
        ];
        let (pos_4, dur_4) = parse_timing_payload_from_args(&args_4);
        assert_eq!(pos_4, Some(45080));
        assert_eq!(dur_4, Some(369840));

        // 2 arguments: [current_seconds, total_seconds]
        let args_2 = vec![
            OscType::Float(10.5),
            OscType::Float(120.0),
        ];
        let (pos_2, dur_2) = parse_timing_payload_from_args(&args_2);
        assert_eq!(pos_2, Some(10500));
        assert_eq!(dur_2, Some(120000));

        // Fallback or 1 argument
        let args_1 = vec![
            OscType::Float(5.2),
        ];
        let (pos_1, dur_1) = parse_timing_payload_from_args(&args_1);
        assert_eq!(pos_1, Some(5200));
        assert_eq!(dur_1, None);
    }
}
