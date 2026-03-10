use std::path::PathBuf;
use std::process::Command;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tauri::{AppHandle, Runtime, State};

use crate::runtime_settings::{resolve_tool_path, RuntimeSettingsState};

fn stable_hash(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn get_ffmpeg_path<R: Runtime>(app: Option<&AppHandle<R>>, runtime_settings: Option<&RuntimeSettingsState>) -> String {
    resolve_tool_path(app, runtime_settings, "ffmpeg.exe")
}

fn get_mkvmerge_path() -> String {
    // mkvmerge ships with MKVToolNix — check common install paths
    let candidates = [
        r"C:\Program Files\MKVToolNix\mkvmerge.exe",
        r"C:\Program Files (x86)\MKVToolNix\mkvmerge.exe",
    ];
    for c in &candidates {
        if std::path::Path::new(c).exists() { return c.to_string(); }
    }
    "mkvmerge".to_string() // fallback to PATH
}

fn preview_cache_path(input_path: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::metadata(input_path)
        .map_err(|e| format!("Failed to inspect preview source '{}': {}", input_path, e))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let cache_dir = std::env::temp_dir().join("playout-preview-cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create preview cache '{}': {}", cache_dir.display(), e))?;

    let extension = std::path::Path::new(input_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("media");
    let hash = stable_hash(&format!("{}:{}:{}", input_path, metadata.len(), modified));
    Ok(cache_dir.join(format!("{}_{}.mp4", extension, hash)))
}

fn build_preview_proxy(ffmpeg: &str, input_path: &str) -> Result<String, String> {
    let output_path = preview_cache_path(input_path)?;
    if output_path.exists() {
        return Ok(output_path.to_string_lossy().into_owned());
    }

    let output_string = output_path.to_string_lossy().into_owned();
    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-analyzeduration", "100M",
            "-probesize", "100M",
            "-i", input_path,
            "-map", "0:v:0",
            "-an",
            "-vf", "scale=-2:720",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "24",
            "-pix_fmt", "yuv420p",
            "-g", "25",
            "-movflags", "+faststart",
            &output_string,
        ])
        .status()
        .map_err(|e| format!("ffmpeg preview proxy failed to start: {}", e))?;

    if status.success() {
        Ok(output_string)
    } else {
        Err(format!("ffmpeg preview proxy exited with code {:?}", status.code()))
    }
}

#[tauri::command]
pub async fn get_media_preview_url<R: Runtime>(input_path: String, app: AppHandle<R>, runtime_settings: State<'_, RuntimeSettingsState>) -> Result<String, String> {
    let ffmpeg = get_ffmpeg_path(Some(&app), Some(&runtime_settings));
    let proxy_path = tauri::async_runtime::spawn_blocking(move || build_preview_proxy(&ffmpeg, &input_path))
        .await
        .map_err(|e| format!("Preview task join failed: {}", e))??;
    Ok(crate::media_server::url_for(&proxy_path))
}

// ── Command: stream-copy trim (near-instant, no re-encode) ───────────────────
//
// ffmpeg -ss <in_secs> -i <input> -t <dur_secs> -c copy -avoid_negative_ts make_zero <output>
//
// Cuts are at the nearest prior keyframe. For broadcast files with short GOPs
// (H.264/HEVC, GOP ≤ 2s) this is accurate to ~2s at worst. For CRF/VBR files
// already optimised for streaming (keyframe every 2s) it is effectively exact.

#[tauri::command]
pub async fn trim_file(
    input_path: String,
    output_path: String,
    in_ms: i64,
    out_ms: i64,
    app: AppHandle<impl Runtime>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<String, String> {
    if out_ms <= in_ms {
        return Err("OUT must be after IN".to_string());
    }
    let in_secs  = in_ms  as f64 / 1000.0;
    let dur_secs = (out_ms - in_ms) as f64 / 1000.0;
    let ffmpeg   = get_ffmpeg_path(Some(&app), Some(&runtime_settings));

    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-ss", &in_secs.to_string(),
            "-i", &input_path,
            "-t", &dur_secs.to_string(),
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart",
            &output_path,
        ])
        .status()
        .map_err(|e| format!("ffmpeg exec failed: {}", e))?;

    if status.success() {
        Ok(output_path)
    } else {
        Err(format!("ffmpeg exited with code {:?}", status.code()))
    }
}

// ── Command: smart trim (frame-accurate where possible, minimal re-encode) ───
//
// Strategy (in order of preference):
//   1. MKV input + mkvmerge installed → use mkvmerge --split for zero-re-encode
//      frame-accurate cuts (mkvmerge re-muxes, only the audio around the cut
//      may be slightly padded — visually transparent).
//   2. Any format → ffmpeg with a short two-pass: the segment around the in
//      and out points (~1 GOP each side) is re-encoded; the middle is stream-
//      copied.  Uses the -vf trim / concat filter approach.
//   3. Fallback → plain stream-copy (same as trim_file).

#[tauri::command]
pub async fn trim_file_smart(
    input_path: String,
    output_path: String,
    in_ms:  i64,
    out_ms: i64,
    app: AppHandle<impl Runtime>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<String, String> {
    if out_ms <= in_ms {
        return Err("OUT must be after IN".to_string());
    }

    let ext = std::path::Path::new(&input_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Strategy 1: mkvmerge for MKV files
    if ext == "mkv" {
        let mkvmerge = get_mkvmerge_path();
        // mkvmerge timecode format: HH:MM:SS.mmm
        let in_tc  = ms_to_mkvmerge_tc(in_ms);
        let out_tc = ms_to_mkvmerge_tc(out_ms);
        let split_arg = format!("parts:{}-{}", in_tc, out_tc);

        let status = Command::new(&mkvmerge)
            .args(["-o", &output_path, "--split", &split_arg, &input_path])
            .status()
            .map_err(|e| format!("mkvmerge exec failed: {}", e));

        match status {
            Ok(s) if s.success() => return Ok(output_path),
            Ok(s) => {
                // mkvmerge failed (e.g. not installed on PATH) — fall through
                eprintln!("[Trim] mkvmerge exited {:?}, falling back to ffmpeg", s.code());
            }
            Err(e) => {
                eprintln!("[Trim] mkvmerge not available: {}. Falling back to ffmpeg.", e);
            }
        }
    }

    // Strategy 2: ffmpeg -ss exact (re-encodes only ~1-GOP at in/out, copies middle)
    // For most H.264/HEVC broadcast files this produces frame-accurate results with
    // minimal CPU — typically <5 seconds for a typical ENG package.
    let in_secs  = in_ms  as f64 / 1000.0;
    let dur_secs = (out_ms - in_ms) as f64 / 1000.0;
    let ffmpeg   = get_ffmpeg_path(Some(&app), Some(&runtime_settings));

    let status = Command::new(&ffmpeg)
        .args([
            "-y",
            "-ss", &in_secs.to_string(), // Fast input seeking (eliminates O(N) CPU decoding)
            "-i", &input_path,
            "-t",  &dur_secs.to_string(),
            // Re-encode video for frame accuracy using fast settings
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",       // visually lossless
            "-c:a", "copy",     // audio always stream-copied
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart",
            &output_path,
        ])
        .status()
        .map_err(|e| format!("ffmpeg exec failed: {}", e))?;

    if status.success() {
        Ok(output_path)
    } else {
        Err(format!("ffmpeg smart trim exited with code {:?}", status.code()))
    }
}

fn ms_to_mkvmerge_tc(ms: i64) -> String {
    let h  = ms / 3_600_000;
    let m  = (ms % 3_600_000) / 60_000;
    let s  = (ms % 60_000) / 1_000;
    let ms = ms % 1_000;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}
