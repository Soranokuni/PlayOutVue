use std::path::{Path, PathBuf};
use std::process::Command;
use std::collections::HashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use crate::db::{MediaDb, CachedMediaEntry};
use crate::diagnostics::DiagnosticState;
use crate::runtime_settings::{resolve_tool_path, RuntimeSettingsState};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct MediaMetadata {
    pub filepath: String,
    pub codec_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub r_frame_rate: String,
    pub display_aspect_ratio: String,
    pub field_order: String,
    pub duration: String, // seconds as string, for backwards compat
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DiscoveredMedia {
    pub filename: String,
    pub path: String,
    pub short_path: String,
    pub entry_kind: String,
    pub media_type: String,
    pub duration: f64,      // seconds
    pub duration_ms: i64,
    pub width: i64,
    pub height: i64,
    pub codec: String,
    pub fps_num: i64,
    pub fps_den: i64,
    pub display_aspect_ratio: String,
    pub field_order: String,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct WarmMediaCacheResult {
    pub checked: i64,
    pub updated: i64,
    pub skipped: i64,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeStatus {
    pub running: bool,
    pub root_path: String,
    pub ffprobe_path: String,
    pub current_file: String,
    pub checked: i64,
    pub updated: i64,
    pub skipped: i64,
    pub total_candidates: i64,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub last_error: String,
}

// ── Managed state wrapper ─────────────────────────────────────────────────────

pub struct DbState(pub MediaDb);
pub struct MediaProbeState(pub Mutex<MediaProbeStatus>);

impl Default for MediaProbeState {
    fn default() -> Self {
        Self(Mutex::new(MediaProbeStatus::default()))
    }
}

const CASPAR_ALIAS_DIR_NAME: &str = "__sota_caspar";

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn log_scanner(diagnostics: &DiagnosticState, level: &str, message: impl Into<String>) {
    diagnostics.push(level, "scanner", message);
}

fn update_probe_status(state: &MediaProbeState, update: impl FnOnce(&mut MediaProbeStatus)) {
    let mut status = state.0.lock();
    update(&mut status);
}

fn snapshot_probe_status(state: &MediaProbeState) -> MediaProbeStatus {
    state.0.lock().clone()
}

fn get_short_path(path: &str) -> String {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;
    
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
    let mut buffer = vec![0u16; 1024];
    
    #[link(name = "kernel32")]
    extern "system" {
        fn GetShortPathNameW(lpszLongPath: *const u16, lpszShortPath: *mut u16, cchBuffer: u32) -> u32;
    }
    
    unsafe {
        let len = GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32);
        if len > 0 && len < buffer.len() as u32 {
            return String::from_utf16_lossy(&buffer[..len as usize]);
        }
    }
    path.to_string()
}

// ── FFprobe path resolution ───────────────────────────────────────────────────
// Tries in order:
//   1. <current_exe_dir>/Requirements/ffmpeg/bin/ffprobe.exe  (production install)
//   2. <cwd>/Requirements/ffmpeg/bin/ffprobe.exe              (cwd = project root)
//   3. <cwd>/../Requirements/ffmpeg/bin/ffprobe.exe           (cwd = src-tauri, dev mode)
//   4. "ffprobe" (system PATH fallback)

fn get_ffprobe_path<R: Runtime>(app: Option<&AppHandle<R>>, runtime_settings: Option<&RuntimeSettingsState>) -> String {
    resolve_tool_path(app, runtime_settings, "ffprobe.exe")
}

fn deserialize_optional_string_like<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Unexpected, Visitor};
    use std::fmt;

    struct OptionalStringLikeVisitor;

    impl<'de> Visitor<'de> for OptionalStringLikeVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a string, number, boolean, or null")
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserialize_optional_string_like(deserializer)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(Some(value))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
        where
            E: Error,
        {
            Ok(Some(value.to_string()))
        }

        fn visit_seq<A>(self, _seq: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            Err(Error::invalid_type(Unexpected::Seq, &self))
        }

        fn visit_map<A>(self, _map: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            Err(Error::invalid_type(Unexpected::Map, &self))
        }
    }

    deserializer.deserialize_any(OptionalStringLikeVisitor)
}

#[derive(Deserialize, Debug)]
struct FfprobeOutput {
    streams: Vec<StreamInfo>,
    format: FormatInfo,
}

#[derive(Deserialize, Debug)]
struct StreamInfo {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    r_frame_rate: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    avg_frame_rate: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    duration: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    duration_ts: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    time_base: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    nb_frames: Option<String>,
    #[serde(default)]
    display_aspect_ratio: Option<String>,
    #[serde(default)]
    field_order: Option<String>,
    tags: Option<HashMap<String, String>>,
}

#[derive(Deserialize, Debug)]
struct FormatInfo {
    #[serde(default, deserialize_with = "deserialize_optional_string_like")]
    duration: Option<String>,
    tags: Option<HashMap<String, String>>,
}

fn parse_float(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if parsed.is_finite() && parsed > 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn parse_i64(value: &str) -> Option<i64> {
    let parsed = value.trim().parse::<i64>().ok()?;
    if parsed > 0 {
        Some(parsed)
    } else {
        None
    }
}

fn parse_ratio_value(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((num, den)) = trimmed.split_once('/') {
        let numerator = num.trim().parse::<f64>().ok()?;
        let denominator = den.trim().parse::<f64>().ok()?;
        if !numerator.is_finite() || !denominator.is_finite() || denominator == 0.0 {
            return None;
        }
        let ratio = numerator / denominator;
        return if ratio.is_finite() && ratio > 0.0 { Some(ratio) } else { None };
    }

    parse_float(trimmed)
}

fn sanitize_display_aspect_ratio(value: Option<String>) -> String {
    let raw = value.unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let lowered = trimmed.to_ascii_lowercase();
    if ["unknown", "n/a", "0:1", "0/1"].contains(&lowered.as_str()) {
        return String::new();
    }

    let normalized = lowered.replace(' ', "").replace(':', "/");
    if let Some(ratio) = parse_ratio_value(&normalized) {
        let near = |left: f64, right: f64| (left - right).abs() < 0.03;
        if near(ratio, 16.0 / 9.0) {
            return "16:9".to_string();
        }
        if near(ratio, 4.0 / 3.0) {
            return "4:3".to_string();
        }
        if near(ratio, 1.0) {
            return "1:1".to_string();
        }
        if near(ratio, 21.0 / 9.0) {
            return "21:9".to_string();
        }
    }

    normalized.replace('/', ":")
}

fn sanitize_field_order(value: Option<String>) -> String {
    let raw = value.unwrap_or_default();
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return String::new();
    }

    match normalized.as_str() {
        "progressive" | "prog" => "progressive".to_string(),
        "tt" | "tb" | "tff" | "top first" | "top_field_first" => "tff".to_string(),
        "bb" | "bt" | "bff" | "bottom first" | "bottom_field_first" => "bff".to_string(),
        _ if normalized.contains("progressive") => "progressive".to_string(),
        _ if normalized.contains("top") => "tff".to_string(),
        _ if normalized.contains("bottom") => "bff".to_string(),
        _ => String::new(),
    }
}

fn parse_tag_duration_seconds(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(seconds) = parse_float(trimmed) {
        return Some(seconds);
    }

    if !trimmed.contains(':') {
        return None;
    }

    let parts = trimmed.split(':').collect::<Vec<_>>();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }

    let seconds = parts[parts.len() - 1].trim().parse::<f64>().ok()?;
    let minutes = parts[parts.len() - 2].trim().parse::<f64>().ok()?;
    let hours = if parts.len() == 3 {
        parts[0].trim().parse::<f64>().ok()?
    } else {
        0.0
    };

    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    if total.is_finite() && total > 0.0 {
        Some(total)
    } else {
        None
    }
}

fn parse_duration_from_tags(tags: &Option<HashMap<String, String>>) -> Option<f64> {
    tags.as_ref()?
        .iter()
        .filter(|(key, _)| key.to_ascii_lowercase().contains("duration"))
        .filter_map(|(_, value)| parse_tag_duration_seconds(value))
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal))
}

fn parse_duration_from_stream(stream: &StreamInfo) -> Option<f64> {
    if let Some(seconds) = stream.duration.as_deref().and_then(parse_float) {
        return Some(seconds);
    }

    if let Some(seconds) = parse_duration_from_tags(&stream.tags) {
        return Some(seconds);
    }

    if let (Some(duration_ts), Some(time_base)) = (
        stream.duration_ts.as_deref().and_then(parse_i64),
        stream.time_base.as_deref().and_then(parse_ratio_value),
    ) {
        let seconds = duration_ts as f64 * time_base;
        if seconds.is_finite() && seconds > 0.0 {
            return Some(seconds);
        }
    }

    if let Some(frame_count) = stream.nb_frames.as_deref().and_then(parse_i64) {
        let fps = stream
            .avg_frame_rate
            .as_deref()
            .and_then(parse_ratio_value)
            .or_else(|| stream.r_frame_rate.as_deref().and_then(parse_ratio_value));
        if let Some(frame_rate) = fps {
            let seconds = frame_count as f64 / frame_rate;
            if seconds.is_finite() && seconds > 0.0 {
                return Some(seconds);
            }
        }
    }

    None
}

fn resolve_duration_secs(parsed: &FfprobeOutput) -> f64 {
    let mut candidates = Vec::new();

    if let Some(seconds) = parsed.format.duration.as_deref().and_then(parse_float) {
        candidates.push(seconds);
    }

    if let Some(seconds) = parse_duration_from_tags(&parsed.format.tags) {
        candidates.push(seconds);
    }

    for stream in parsed.streams.iter().filter(|stream| stream.codec_type == "video" || stream.codec_type == "audio") {
        if let Some(seconds) = parse_duration_from_stream(stream) {
            candidates.push(seconds);
        }
    }

    candidates
        .into_iter()
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(0.0)
}

fn load_cached_or_probe(
    ffprobe: &str,
    filepath: &str,
    db: &MediaDb,
    diagnostics: Option<&DiagnosticState>,
) -> Result<CachedMediaEntry, String> {
    let cached = db.get_valid(filepath);

    if let Some(valid) = cached.as_ref().filter(|entry| entry.duration_ms > 0) {
        return Ok(valid.clone());
    }

    match run_ffprobe(ffprobe, filepath, diagnostics) {
        Ok(entry) => {
            let _ = db.upsert(&entry);
            Ok(entry)
        }
        Err(error) => {
            if let Some(diagnostics) = diagnostics {
                log_scanner(diagnostics, "warn", format!("Probe failed for '{}': {}", filepath.replace('\\', "/"), error));
            }
            cached.ok_or(error)
        }
    }
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn run_ffprobe(ffprobe: &str, filepath: &str, diagnostics: Option<&DiagnosticState>) -> Result<CachedMediaEntry, String> {
    let mut command = Command::new(ffprobe);
    command.args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filepath]);

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|e| format!("ffprobe exec failed: {}", e))?;

    if !output.status.success() {
        let error = format!("ffprobe stderr: {}", String::from_utf8_lossy(&output.stderr));
        if let Some(diagnostics) = diagnostics {
            log_scanner(diagnostics, "error", format!("ffprobe exited unsuccessfully for '{}': {}", filepath.replace('\\', "/"), error));
        }
        return Err(error);
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| {
            let error = format!("ffprobe JSON parse: {}", e);
            if let Some(diagnostics) = diagnostics {
                log_scanner(diagnostics, "error", format!("ffprobe JSON parse failed for '{}': {}", filepath.replace('\\', "/"), error));
            }
            error
        })?;

    let vstream = parsed.streams.iter().find(|s| s.codec_type == "video");
    let duration_secs = resolve_duration_secs(&parsed);
    let raw_display_aspect_ratio = vstream.and_then(|stream| stream.display_aspect_ratio.clone());
    let raw_field_order = vstream.and_then(|stream| stream.field_order.clone());
    let display_aspect_ratio = sanitize_display_aspect_ratio(raw_display_aspect_ratio.clone());
    let field_order = sanitize_field_order(raw_field_order.clone());

    // Parse FPS fraction e.g. "25/1" or "30000/1001"
    let (fps_num, fps_den) = vstream
        .and_then(|s| s.r_frame_rate.as_deref())
        .map(parse_fps)
        .unwrap_or((25, 1));

    if duration_secs <= 0.0 {
        if let Some(diagnostics) = diagnostics {
            log_scanner(diagnostics, "warn", format!("ffprobe returned zero duration for '{}'", filepath.replace('\\', "/")));
        }
    }

    if let Some(diagnostics) = diagnostics {
        if vstream.is_none() {
            log_scanner(diagnostics, "warn", format!("ffprobe returned no video stream for '{}' while extracting extended metadata", filepath.replace('\\', "/")));
        }

        if raw_display_aspect_ratio.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_some() && display_aspect_ratio.is_empty() {
            log_scanner(diagnostics, "warn", format!("ffprobe display_aspect_ratio could not be normalized for '{}': {:?}", filepath.replace('\\', "/"), raw_display_aspect_ratio));
        }

        if raw_field_order.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_some() && field_order.is_empty() {
            log_scanner(diagnostics, "warn", format!("ffprobe field_order could not be normalized for '{}': {:?}", filepath.replace('\\', "/"), raw_field_order));
        }
    }

    Ok(CachedMediaEntry {
        path: filepath.to_string(),
        duration_ms: (duration_secs * 1000.0).round() as i64,
        width:  vstream.and_then(|s| s.width).unwrap_or(0) as i64,
        height: vstream.and_then(|s| s.height).unwrap_or(0) as i64,
        codec:  vstream.and_then(|s| s.codec_name.clone()).unwrap_or_default(),
        fps_num,
        fps_den,
        display_aspect_ratio,
        field_order,
        timecode_start: "00:00:00:00".to_string(),
    })
}

fn parse_fps(fps_str: &str) -> (i64, i64) {
    let parts: Vec<&str> = fps_str.split('/').collect();
    if parts.len() == 2 {
        let n = parts[0].parse::<i64>().unwrap_or(25);
        let d = parts[1].parse::<i64>().unwrap_or(1);
        (n, d)
    } else {
        (fps_str.parse::<i64>().unwrap_or(25), 1)
    }
}

fn is_supported_media_extension(ext: &str) -> bool {
    ["mp4", "mkv", "mov", "mxf", "avi", "webm", "ts", "m2ts"].contains(&ext)
}

fn collect_media_files(root: &PathBuf) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.clone()];

    while let Some(dir) = pending.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read directory '{}': {}", dir.to_string_lossy(), e))?;

        for entry in entries.flatten() {
            let file_path = entry.path();

            if file_path.is_dir() {
                if file_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.eq_ignore_ascii_case(CASPAR_ALIAS_DIR_NAME))
                    .unwrap_or(false)
                {
                    continue;
                }

                pending.push(file_path);
                continue;
            }

            if !file_path.is_file() {
                continue;
            }

            let Some(ext) = file_path.extension().and_then(|value| value.to_str()) else {
                continue;
            };

            if is_supported_media_extension(&ext.to_lowercase()) {
                files.push(file_path);
            }
        }
    }

    files.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    Ok(files)
}

fn warm_media_files(
    ffprobe: &str,
    files: &[PathBuf],
    db: &MediaDb,
    diagnostics: &DiagnosticState,
    mut on_progress: impl FnMut(&Path, &WarmMediaCacheResult),
) -> Result<WarmMediaCacheResult, String> {
    let mut stats = WarmMediaCacheResult::default();

    for file_path in files {
        let path_str = file_path.to_string_lossy().into_owned();
        stats.checked += 1;

        let existing = db.get_valid(&path_str);

        if existing.as_ref().is_some_and(|entry| entry.duration_ms > 0) {
            stats.skipped += 1;
            on_progress(file_path, &stats);
            continue;
        }

        match load_cached_or_probe(ffprobe, &path_str, db, Some(diagnostics)) {
            Ok(entry) if entry.duration_ms > 0 => {
                stats.updated += 1;
            }
            Ok(_) => {
                stats.skipped += 1;
            }
            Err(_) => {
                stats.skipped += 1;
            }
        }

        on_progress(file_path, &stats);
    }

    Ok(stats)
}

fn run_background_probe(
    root: &PathBuf,
    ffprobe: &str,
    db: &MediaDb,
    probe_state: &MediaProbeState,
    diagnostics: &DiagnosticState,
) -> Result<WarmMediaCacheResult, String> {
    let files = collect_media_files(root)?;
    update_probe_status(probe_state, |status| {
        status.total_candidates = files.len() as i64;
    });

    log_scanner(
        diagnostics,
        "info",
        format!(
            "Background media probe scanning {} file(s) under '{}' using '{}'",
            files.len(),
            normalize_display_path(root),
            ffprobe
        ),
    );

    let stats = warm_media_files(ffprobe, &files, db, diagnostics, |file_path, stats| {
        update_probe_status(probe_state, |status| {
            status.current_file = normalize_display_path(file_path);
            status.checked = stats.checked;
            status.updated = stats.updated;
            status.skipped = stats.skipped;
        });
    })?;

    update_probe_status(probe_state, |status| {
        status.running = false;
        status.current_file.clear();
        status.checked = stats.checked;
        status.updated = stats.updated;
        status.skipped = stats.skipped;
        status.finished_at_ms = now_ms();
        status.last_error.clear();
    });

    log_scanner(
        diagnostics,
        "info",
        format!(
            "Background media probe finished for '{}': checked={}, updated={}, skipped={}",
            normalize_display_path(root),
            stats.checked,
            stats.updated,
            stats.skipped
        ),
    );

    Ok(stats)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_media_probe_status(probe_state: State<'_, MediaProbeState>) -> MediaProbeStatus {
    snapshot_probe_status(&probe_state)
}

#[tauri::command]
pub async fn start_media_probe<R: Runtime>(
    path: String,
    app: AppHandle<R>,
    probe_state: State<'_, MediaProbeState>,
    diagnostics: State<'_, DiagnosticState>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<MediaProbeStatus, String> {
    let target_dir = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Ok(snapshot_probe_status(&probe_state));
    }
    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let current = snapshot_probe_status(&probe_state);
    if current.running {
        return Ok(current);
    }

    let ffprobe = get_ffprobe_path(Some(&app), Some(&runtime_settings));
    update_probe_status(&probe_state, |status| {
        *status = MediaProbeStatus {
            running: true,
            root_path: normalize_display_path(&target_dir),
            ffprobe_path: ffprobe.clone(),
            current_file: String::new(),
            checked: 0,
            updated: 0,
            skipped: 0,
            total_candidates: 0,
            started_at_ms: now_ms(),
            finished_at_ms: 0,
            last_error: String::new(),
        };
    });

    if Path::new(&ffprobe).exists() {
        log_scanner(&diagnostics, "info", format!("Resolved ffprobe executable to '{}'", ffprobe));
    } else {
        log_scanner(&diagnostics, "warn", format!("ffprobe not bundled at a known path. Falling back to PATH lookup via '{}'", ffprobe));
    }

    let app_handle = app.clone();
    let ffprobe_clone = ffprobe.clone();
    let root_clone = target_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let diagnostics = app_handle.state::<DiagnosticState>();
        let probe_state = app_handle.state::<MediaProbeState>();
        let db_state = app_handle.state::<DbState>();

        if let Err(error) = run_background_probe(&root_clone, &ffprobe_clone, &db_state.0, &probe_state, &diagnostics) {
            log_scanner(&diagnostics, "error", format!("Background media probe failed for '{}': {}", normalize_display_path(&root_clone), error));
            update_probe_status(&probe_state, |status| {
                status.running = false;
                status.current_file.clear();
                status.finished_at_ms = now_ms();
                status.last_error = error;
            });
        }
    });

    Ok(snapshot_probe_status(&probe_state))
}

/// Probe a single file, using DB cache when valid.
#[tauri::command]
pub async fn scan_media<R: Runtime>(
    filepath: String,
    app: AppHandle<R>,
    _db_state: State<'_, DbState>,
    _diagnostics: State<'_, DiagnosticState>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<MediaMetadata, String> {
    let ffprobe = get_ffprobe_path(Some(&app), Some(&runtime_settings));
    let app_handle = app.clone();
    let filepath_clone = filepath.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let db_state = app_handle.state::<DbState>();
        let diagnostics = app_handle.state::<DiagnosticState>();
        let entry = load_cached_or_probe(&ffprobe, &filepath_clone, &db_state.0, Some(&diagnostics))?;
        let dur_secs = entry.duration_ms as f64 / 1000.0;

        Ok(MediaMetadata {
            filepath: entry.path.clone(),
            codec_name: entry.codec.clone(),
            width:  Some(entry.width as u32),
            height: Some(entry.height as u32),
            r_frame_rate: format!("{}/{}", entry.fps_num, entry.fps_den),
            display_aspect_ratio: entry.display_aspect_ratio.clone(),
            field_order: entry.field_order.clone(),
            duration: dur_secs.to_string(),
        })
    })
    .await
    .map_err(|error| format!("Media scan worker failed: {}", error))?
}

/// Scan a directory.  Uses cache for known files, runs ffprobe only on new/changed ones.
#[tauri::command]
pub async fn scan_directory(
    path: String,
    db_state: State<'_, DbState>,
) -> Result<Vec<DiscoveredMedia>, String> {
    let db = db_state.0.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let target_dir = PathBuf::from(&path);

        if !target_dir.exists() || !target_dir.is_dir() {
            return Err(format!("Directory does not exist: {}", path));
        }

        let mut results = Vec::new();

        fn visit_directory(
            dir: &PathBuf,
            root: &PathBuf,
            db: &MediaDb,
            results: &mut Vec<DiscoveredMedia>,
        ) -> Result<(), String> {
            let entries = std::fs::read_dir(dir)
                .map_err(|e| format!("Failed to read directory '{}': {}", dir.to_string_lossy(), e))?;

            for entry in entries.flatten() {
                let file_path = entry.path();

                if file_path.is_dir() {
                    if file_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(|name| name.eq_ignore_ascii_case(CASPAR_ALIAS_DIR_NAME))
                        .unwrap_or(false)
                    {
                        continue;
                    }

                    if file_path != *root {
                        let path_str = file_path.to_string_lossy().into_owned();
                        let path_fwd = path_str.replace('\\', "/");
                        results.push(DiscoveredMedia {
                            filename: file_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                            path: path_fwd.clone(),
                            short_path: get_short_path(&path_str).replace('\\', "/"),
                            entry_kind: "folder".to_string(),
                            media_type: "folder".to_string(),
                            duration: 0.0,
                            duration_ms: 0,
                            width: 0,
                            height: 0,
                            codec: String::new(),
                            fps_num: 0,
                            fps_den: 1,
                            display_aspect_ratio: String::new(),
                            field_order: String::new(),
                        });
                    }

                    visit_directory(&file_path, root, db, results)?;
                    continue;
                }

                if !file_path.is_file() {
                    continue;
                }

                let ext = match file_path.extension().and_then(|e| e.to_str()) {
                    Some(e) => e.to_lowercase(),
                    None => continue,
                };

                if !is_supported_media_extension(&ext) {
                    continue;
                }

                let path_str = file_path.to_string_lossy().into_owned();
                let path_fwd = path_str.replace('\\', "/");

                let entry_meta = db.get_valid(&path_str).unwrap_or(CachedMediaEntry {
                    path: path_str.clone(),
                    duration_ms: 0,
                    width: 0,
                    height: 0,
                    codec: String::new(),
                    fps_num: 25,
                    fps_den: 1,
                    display_aspect_ratio: String::new(),
                    field_order: String::new(),
                    timecode_start: "00:00:00:00".to_string(),
                });

                results.push(DiscoveredMedia {
                    filename: file_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    path: path_fwd,
                    short_path: get_short_path(&path_str).replace('\\', "/"),
                    entry_kind: "file".to_string(),
                    media_type: "video".to_string(),
                    duration:    entry_meta.duration_ms as f64 / 1000.0,
                    duration_ms: entry_meta.duration_ms,
                    width:        entry_meta.width,
                    height:       entry_meta.height,
                    codec:        entry_meta.codec,
                    fps_num:      entry_meta.fps_num,
                    fps_den:      entry_meta.fps_den,
                    display_aspect_ratio: entry_meta.display_aspect_ratio,
                    field_order:  entry_meta.field_order,
                });
            }

            Ok(())
        }

        visit_directory(&target_dir, &target_dir, &db, &mut results)?;

        results.sort_by(|a, b| {
            match (a.entry_kind.as_str(), b.entry_kind.as_str()) {
                ("folder", "file") => std::cmp::Ordering::Less,
                ("file", "folder") => std::cmp::Ordering::Greater,
                _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
            }
        });
        Ok(results)
    })
    .await
    .map_err(|error| format!("Directory scan worker failed: {}", error))?
}

#[tauri::command]
pub async fn warm_media_cache<R: Runtime>(
    path: String,
    app: AppHandle<R>,
    db_state: State<'_, DbState>,
    diagnostics: State<'_, DiagnosticState>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<WarmMediaCacheResult, String> {
    let ffprobe = get_ffprobe_path(Some(&app), Some(&runtime_settings));
    let db = db_state.0.clone();
    let target_dir = PathBuf::from(&path);

    if path.trim().is_empty() {
        return Ok(WarmMediaCacheResult::default());
    }

    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!("Directory does not exist: {}", path));
    }

    log_scanner(
        &diagnostics,
        "info",
        format!(
            "Synchronous media cache warm-up requested for '{}' using '{}'",
            normalize_display_path(&target_dir),
            ffprobe
        ),
    );

    let app_handle = app.clone();
    let target_dir_for_log = target_dir.clone();

    let stats = tauri::async_runtime::spawn_blocking(move || {
        let files = collect_media_files(&target_dir)?;
        let diagnostics = app_handle.state::<DiagnosticState>();
        warm_media_files(&ffprobe, &files, &db, &diagnostics, |_file_path, _stats| {})
    })
    .await
    .map_err(|error| format!("Media warm-up worker failed: {}", error))??;

    log_scanner(
        &diagnostics,
        "info",
        format!(
            "Synchronous media cache warm-up finished for '{}': checked={}, updated={}, skipped={}",
            normalize_display_path(&target_dir_for_log),
            stats.checked,
            stats.updated,
            stats.skipped
        ),
    );

    Ok(stats)
}
