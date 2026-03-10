use std::process::Command;
use std::path::PathBuf;
use std::sync::Mutex;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::{MediaDb, CachedMediaEntry};

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct MediaMetadata {
    pub filepath: String,
    pub codec_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub r_frame_rate: String,
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
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct WarmMediaCacheResult {
    pub checked: i64,
    pub updated: i64,
    pub skipped: i64,
}

// ── Managed state wrapper ─────────────────────────────────────────────────────

pub struct DbState(pub Mutex<MediaDb>);

const CASPAR_ALIAS_DIR_NAME: &str = "__sota_caspar";

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

fn find_tool(name: &str) -> String {
    let candidates: Vec<PathBuf> = {
        let sub = ["Requirements", "ffmpeg", "bin", name];
        let mut v = Vec::new();
        // Exe-relative (production)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                v.push(sub.iter().fold(dir.to_path_buf(), |acc, s| acc.join(s)));
            }
        }
        // CWD (project root when running `npm run tauri dev`)
        if let Ok(cwd) = std::env::current_dir() {
            v.push(sub.iter().fold(cwd.clone(), |acc, s| acc.join(s)));
            // Parent of CWD (src-tauri dir in dev)
            if let Some(parent) = cwd.parent() {
                v.push(sub.iter().fold(parent.to_path_buf(), |acc, s| acc.join(s)));
            }
        }
        v
    };
    candidates.into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.trim_end_matches(".exe").to_string())
}

fn get_ffprobe_path() -> String { find_tool("ffprobe.exe") }

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
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    duration_ts: Option<String>,
    time_base: Option<String>,
    nb_frames: Option<String>,
    tags: Option<HashMap<String, String>>,
}

#[derive(Deserialize, Debug)]
struct FormatInfo {
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
    db_state: &State<'_, DbState>,
) -> Result<CachedMediaEntry, String> {
    let cached = {
        let db = db_state.0.lock().map_err(|e| e.to_string())?;
        db.get_valid(filepath)
    };

    if let Some(valid) = cached.as_ref().filter(|entry| entry.duration_ms > 0) {
        return Ok(valid.clone());
    }

    match run_ffprobe(ffprobe, filepath) {
        Ok(entry) => {
            if let Ok(db) = db_state.0.lock() {
                let _ = db.upsert(&entry);
            }
            Ok(entry)
        }
        Err(error) => cached.ok_or(error),
    }
}

fn run_ffprobe(ffprobe: &str, filepath: &str) -> Result<CachedMediaEntry, String> {
    let output = Command::new(ffprobe)
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filepath])
        .output()
        .map_err(|e| format!("ffprobe exec failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("ffprobe stderr: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("ffprobe JSON parse: {}", e))?;

    let vstream = parsed.streams.iter().find(|s| s.codec_type == "video");
    let duration_secs = resolve_duration_secs(&parsed);

    // Parse FPS fraction e.g. "25/1" or "30000/1001"
    let (fps_num, fps_den) = vstream
        .and_then(|s| s.r_frame_rate.as_deref())
        .map(parse_fps)
        .unwrap_or((25, 1));

    Ok(CachedMediaEntry {
        path: filepath.to_string(),
        duration_ms: (duration_secs * 1000.0).round() as i64,
        width:  vstream.and_then(|s| s.width).unwrap_or(0) as i64,
        height: vstream.and_then(|s| s.height).unwrap_or(0) as i64,
        codec:  vstream.and_then(|s| s.codec_name.clone()).unwrap_or_default(),
        fps_num,
        fps_den,
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

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Probe a single file, using DB cache when valid.
#[tauri::command]
pub async fn scan_media(
    filepath: String,
    db_state: State<'_, DbState>,
) -> Result<MediaMetadata, String> {
    let ffprobe = get_ffprobe_path();
    let entry = load_cached_or_probe(&ffprobe, &filepath, &db_state)?;
    let dur_secs = entry.duration_ms as f64 / 1000.0;
    let meta = MediaMetadata {
        filepath: entry.path.clone(),
        codec_name: entry.codec.clone(),
        width:  Some(entry.width as u32),
        height: Some(entry.height as u32),
        r_frame_rate: format!("{}/{}", entry.fps_num, entry.fps_den),
        duration: dur_secs.to_string(),
    };

    Ok(meta)
}

/// Scan a directory.  Uses cache for known files, runs ffprobe only on new/changed ones.
#[tauri::command]
pub async fn scan_directory(
    path: String,
    db_state: State<'_, DbState>,
) -> Result<Vec<DiscoveredMedia>, String> {
    let ffprobe = get_ffprobe_path();
    let target_dir = PathBuf::from(&path);

    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let mut results = Vec::new();

    fn visit_directory(
        dir: &PathBuf,
        root: &PathBuf,
        ffprobe: &str,
        db_state: &State<'_, DbState>,
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
                    });
                }

                visit_directory(&file_path, root, ffprobe, db_state, results)?;
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
            let path_fwd = path_str.replace('\\', "/"); // normalise for frontend

            let entry_meta = {
                let db = db_state.0.lock().map_err(|e| e.to_string())?;
                db.get_valid(&path_str).unwrap_or(CachedMediaEntry {
                    path: path_str.clone(),
                    duration_ms: 0,
                    width: 0,
                    height: 0,
                    codec: String::new(),
                    fps_num: 25,
                    fps_den: 1,
                    timecode_start: "00:00:00:00".to_string(),
                })
            };

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
            });
        }

        Ok(())
    }

    visit_directory(&target_dir, &target_dir, &ffprobe, &db_state, &mut results)?;

    results.sort_by(|a, b| {
        match (a.entry_kind.as_str(), b.entry_kind.as_str()) {
            ("folder", "file") => std::cmp::Ordering::Less,
            ("file", "folder") => std::cmp::Ordering::Greater,
            _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
        }
    });
    Ok(results)
}

#[tauri::command]
pub async fn warm_media_cache(
    path: String,
    db_state: State<'_, DbState>,
) -> Result<WarmMediaCacheResult, String> {
    let ffprobe = get_ffprobe_path();
    let target_dir = PathBuf::from(&path);

    if path.trim().is_empty() {
        return Ok(WarmMediaCacheResult::default());
    }

    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!("Directory does not exist: {}", path));
    }

    fn visit_directory(
        dir: &PathBuf,
        ffprobe: &str,
        db_state: &State<'_, DbState>,
        stats: &mut WarmMediaCacheResult,
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

                visit_directory(&file_path, ffprobe, db_state, stats)?;
                continue;
            }

            if !file_path.is_file() {
                continue;
            }

            let ext = match file_path.extension().and_then(|e| e.to_str()) {
                Some(ext) => ext.to_lowercase(),
                None => continue,
            };

            if !is_supported_media_extension(&ext) {
                continue;
            }

            let path_str = file_path.to_string_lossy().into_owned();
            stats.checked += 1;

            let existing = {
                let db = db_state.0.lock().map_err(|e| e.to_string())?;
                db.get_valid(&path_str)
            };

            if existing.as_ref().is_some_and(|entry| entry.duration_ms > 0) {
                stats.skipped += 1;
                continue;
            }

            match load_cached_or_probe(ffprobe, &path_str, db_state) {
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
        }

        Ok(())
    }

    let mut stats = WarmMediaCacheResult::default();
    visit_directory(&target_dir, &ffprobe, &db_state, &mut stats)?;
    Ok(stats)
}
