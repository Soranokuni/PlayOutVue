use std::path::Path;
use tauri::{AppHandle, Runtime, State};

use crate::media_index;
use crate::scanner::probe_media_metadata;
use crate::transcoder_sidecar;
use crate::runtime_settings::{resolve_tool_path, RuntimeSettingsState};

fn get_ffmpeg_path<R: Runtime>(app: Option<&AppHandle<R>>, runtime_settings: Option<&RuntimeSettingsState>) -> String {
    resolve_tool_path(app, runtime_settings, "ffmpeg.exe")
}

/// Returns a streaming URL that serves the original file over the local media server.
/// Unlike the previous implementation, this command does *not* write a transcoded proxy.
#[tauri::command]
pub async fn get_media_preview_url<R: Runtime>(
    input_path: String,
    _app: AppHandle<R>,
    _runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<String, String> {
    let path = Path::new(&input_path);
    if !path.exists() {
        return Err(format!("Preview source does not exist: {}", input_path));
    }
    if !path.is_file() {
        return Err(format!("Preview source is not a file: {}", input_path));
    }
    Ok(crate::media_server::url_for(&input_path))
}

/// Lightweight probe for the trim panel. Returns:
///   1. duration in milliseconds,
///   2. an estimated frame count,
///   3. a preview JPEG frame as a base64 `data:image/jpeg;base64,...` URI.
/// The frame is captured from FFmpeg stdout so no proxy or trimmed file is written.
#[tauri::command]
pub async fn get_media_preview_info<R: Runtime>(
    input_path: String,
    app: AppHandle<R>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<(i64, i64, String), String> {
    use std::process::Command;

    let ffmpeg = get_ffmpeg_path(Some(&app), Some(&runtime_settings));

    // Run ffprobe for duration and frame count.
    let probe = Command::new(&ffmpeg.replace("ffmpeg.exe", "ffprobe.exe"))
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=nb_frames:stream=duration",
            "-show_entries", "format=duration",
            "-of", "csv=p=0:nk=1",
            &input_path,
        ])
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    let probe_stdout = String::from_utf8_lossy(&probe.stdout);
    let probe_lines: Vec<&str> = probe_stdout.lines().collect();

    let duration_ms = probe_lines
        .iter()
        .filter_map(|line| line.split(',').next())
        .filter_map(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .next()
        .unwrap_or(0);

    let frame_count = probe_lines
        .iter()
        .filter_map(|line| line.split(',').nth(1))
        .filter_map(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0)
        .map(|frames| frames as i64)
        .next()
        .unwrap_or(0);

    // Extract a single preview frame from the first second into memory.
    let output = Command::new(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-ss", "00:00:01.000",
            "-i", &input_path,
            "-frames:v", "1",
            "-q:v", "2",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("ffmpeg preview frame failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ffmpeg preview frame exited unsuccessfully: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &output.stdout);
    let preview_uri = format!("data:image/jpeg;base64,{}", base64);

    Ok((duration_ms, frame_count, preview_uri))
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct FrameTrimResult {
    pub in_frame: u32,
    pub out_frame: u32,
    pub duration_frames: u32,
    pub fps_rational: String,
}

/// Robust timecode parser. Accepts MM:SS, HH:MM:SS, HH:MM:SS:FF (and
/// S, SS.FF, MM:SS.FF variants) and returns the equivalent frame count at the
/// given frame rate. Returns None when the string cannot be interpreted.
///
/// This replaces the fragile per-component math that previously failed on
/// "6:04" / "34:26" style IN/OUT strings, fell through to a degenerate
/// +2000ms fallback, and ultimately produced a bogus 2-minute LENGTH.
pub fn parse_timecode_to_frames(tc: &str, fps: f64) -> Option<u32> {
    let fps = if !fps.is_finite() || fps <= 0.0 { 25.0 } else { fps };
    let trimmed = tc.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Pure integer frame count (e.g. "18390")
    if !trimmed.contains(':') && !trimmed.contains('.') {
        if let Ok(frames) = trimmed.parse::<u32>() {
            return Some(frames);
        }
    }

    // Split on ':' — each segment is numeric. A trailing fractional seconds
    // segment (e.g. "01.5") is tolerated by parsing as f64.
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }

    let parsed: Vec<f64> = parts
        .iter()
        .map(|p| p.parse::<f64>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;

    let (h, m, s, f) = match parsed.len() {
        2 => (0.0, parsed[0], parsed[1], 0.0),                 // MM:SS
        3 => (parsed[0], parsed[1], parsed[2], 0.0),          // HH:MM:SS
        4 => (parsed[0], parsed[1], parsed[2], parsed[3]),    // HH:MM:SS:FF
        _ => return None,
    };

    if h < 0.0 || m < 0.0 || s < 0.0 || f < 0.0 {
        return None;
    }

    let nominal_fps = if (fps - 29.97).abs() < 0.05 {
        30.0
    } else if (fps - 59.94).abs() < 0.05 {
        60.0
    } else if (fps - 23.976).abs() < 0.05 {
        24.0
    } else {
        fps
    };

    let frames = (h * 3600.0 + m * 60.0 + s) * nominal_fps + f.round();
    if !frames.is_finite() || frames < 0.0 {
        return None;
    }
    Some(frames.round() as u32)
}

/// Parse a timecode string to milliseconds at the given frame rate. Mirrors
/// `parse_timecode_to_frames` for callers that work in milliseconds (the UI
/// trim controls, timeline triggers, etc.).
pub fn parse_timecode_to_ms(tc: &str, fps: f64) -> Option<i64> {
    let frames = parse_timecode_to_frames(tc, fps)?;
    let fps = if !fps.is_finite() || fps <= 0.0 { 25.0 } else { fps };
    let ms = (frames as f64 / fps) * 1000.0;
    if !ms.is_finite() || ms < 0.0 {
        return None;
    }
    Some(ms.round() as i64)
}

/// Tauri-exposed timecode parser so the Vue layer can validate/convert IN and
/// OUT strings through the exact same code path the backend uses for frame
/// math. Returns the frame count and millisecond equivalent.
#[derive(serde::Serialize)]
pub struct TimecodeParseResult {
    pub frames: u32,
    pub ms: i64,
    pub fps: f64,
}

#[tauri::command]
pub async fn parse_timecode(
    tc: String,
    fps: Option<f64>,
) -> Result<TimecodeParseResult, String> {
    let rate = fps.unwrap_or(25.0);
    let frames = parse_timecode_to_frames(&tc, rate)
        .ok_or_else(|| format!("Could not parse timecode '{}' (expected MM:SS, HH:MM:SS, or HH:MM:SS:FF)", tc))?;
    let ms = parse_timecode_to_ms(&tc, rate).unwrap_or(0);
    Ok(TimecodeParseResult { frames, ms, fps: rate })
}

#[tauri::command]
pub async fn compute_frame_trim<R: Runtime>(
    path: String,
    trim_in_ms: i64,
    trim_out_ms: i64,
    app: AppHandle<R>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    db_state: State<'_, crate::scanner::DbState>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<FrameTrimResult, String> {
    // Look up the asset in the in-memory SQLite DB first. If it hasn't been
    // probed yet (the background scanner may still be running, or the file was
    // just added), fall back to (1) the transcoder sidecar JSON written next
    // to the media, then (2) the portable JSON index, then (3) a direct
    // ffprobe of the file. This prevents "Asset not found in database" errors
    // on first playback. The resolved entry is upserted into the DB so
    // subsequent lookups hit the fast path.
    let entry = if let Some(e) = db_state.0.get_entry(&path)
        .filter(|e| e.fps_num > 0 && e.duration_ms > 0)
    {
        e
    } else if let Some(sc) = transcoder_sidecar::read_sidecar(Path::new(&path)) {
        let mut entry = transcoder_sidecar::sidecar_to_cached_entry(&sc, &path);
        let _ = db_state.0.upsert(&entry);
        entry.path = path.clone();
        entry
    } else if let Some(e) = media_index::find_media_root_for_path(Path::new(&path))
        .and_then(|root| {
            media_index::hydrate_entry_from_index(&root, Path::new(&path))
                .ok()
                .flatten()
        })
    {
        let _ = db_state.0.upsert(&e);
        e
    } else if Path::new(&path).is_file() {
        // Metadata race fallback: the file exists but has no cache entry,
        // sidecar, or index entry yet — the ingestor copies the file before
        // writing the sidecar JSON, and the scanner may still be behind (or
        // hold a stale mid-copy entry filtered out above). Probing directly
        // keeps the take from failing with "Asset not found" and skipping to
        // the next item.
        let entry = probe_media_metadata(Some(&app), Some(&runtime_settings), &path, Some(&diagnostics))
            .map_err(|e| format!("Asset probe failed for {}: {}", path, e))?;
        let _ = db_state.0.upsert(&entry);
        entry
    } else {
        return Err(format!("Asset not found in database, sidecar, or portable index: {}", path));
    };

    if entry.fps_num <= 0 || entry.fps_den <= 0 {
        return Err(format!(
            "Invalid frame rate for asset: {}/{}",
            entry.fps_num, entry.fps_den
        ));
    }

    let fps = entry.fps_num as f64 / entry.fps_den as f64;
    let total_dur = if entry.duration_ms < 0 { 0 } else { entry.duration_ms };

    let in_ms = trim_in_ms.max(0);
    let requested_out_ms = if trim_out_ms <= 0 { total_dur } else { trim_out_ms };

    // Diagnostic: log every trim computation so mismatches between parent-source
    // trim coordinates and the actual file duration are visible in the Rust log.
    // When trim points exceed the file bounds, the trim is clamped — but the
    // frontend may still display the pre-clamped values. This log exposes the
    // delta so an operator can identify the mismatch.
    let out_clamped = requested_out_ms > total_dur;
    let in_clamped = in_ms > total_dur;
    if out_clamped || in_clamped {
        diagnostics.push(
            "warn",
            "trim",
            format!(
                "CLAMPED path={:?} file_ms={} in_req={} out_req={} → in_eff={} out_eff={}",
                path,
                total_dur,
                trim_in_ms,
                trim_out_ms,
                in_ms.min(total_dur),
                requested_out_ms.min(total_dur)
            ),
        );
    } else {
        diagnostics.push(
            "info",
            "trim",
            format!(
                "OK path={:?} file_ms={} in_ms={} out_ms={} effective_ms={} fps={}/{}",
                path,
                total_dur,
                in_ms,
                requested_out_ms,
                requested_out_ms.saturating_sub(in_ms),
                entry.fps_num,
                entry.fps_den
            ),
        );
    }

    // Clamp trim_in_ms between 0 and the file's real duration. The previous
    // implementation trusted the DB duration blindly; an inflated DB duration
    // let IN points beyond the real file through, which produced a SEEK past
    // EOF and a corrupted LENGTH. Hard-clamp to [0, total_dur].
    let in_ms = if in_ms > total_dur {
        diagnostics.push(
            "error",
            "trim",
            format!(
                "BAD IN: trim_in_ms={} exceeds file duration={} for {:?}. Trim panel uses parent-source coordinates on a pre-extracted subclip file.",
                in_ms, total_dur, path
            ),
        );
        0
    } else {
        in_ms
    };

    // Resolve the OUT point. trim_out_ms <= 0 or beyond the file means "play
    // to the end". Otherwise clamp it into (in_ms, total_dur].
    let out_ms = if trim_out_ms <= 0 || trim_out_ms > total_dur {
        total_dur
    } else {
        trim_out_ms.max(in_ms).min(total_dur)
    };

    if out_ms <= in_ms {
        // Degenerate trim (e.g. IN clamped to the very end because it exceeded
        // the real file length). Previously this fell back to a hardcoded
        // `in_ms + 2000` phantom window which is what produced the spurious
        // ~2s/2min clip. Instead, surface a clear error so the caller marks
        // the item as broken rather than silently playing a stub.
        return Err(format!(
            "Degenerate trim for {}: IN {}ms is at/after the file end ({}ms). \
             The IN point exceeds the real media duration — adjust the trim.",
            path, in_ms, total_dur
        ));
    }

    // Convert milliseconds to frame counts. IN is floored, OUT is ceiled so
    // the LENGTH is never shorter than the requested trim.
    let in_frame = ((in_ms as f64 / 1000.0) * fps).floor() as u32;
    let out_frame_raw = ((out_ms as f64 / 1000.0) * fps).ceil() as u32;
    let total_frames = ((total_dur as f64 / 1000.0) * fps).round() as u32;

    // Hard cap OUT at the real total frame count (never produce a LENGTH that
    // runs past the file — that was the other source of the 2-minute stub).
    let out_frame = std::cmp::min(out_frame_raw, total_frames.max(1));

    let duration_frames = out_frame.saturating_sub(in_frame);

    Ok(FrameTrimResult {
        in_frame,
        out_frame,
        duration_frames,
        fps_rational: format!("{}/{}", entry.fps_num, entry.fps_den),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_timecode_mmss_25fps() {
        // "6:04" → MM:SS = 364s → 9100 frames at 25fps
        assert_eq!(parse_timecode_to_frames("6:04", 25.0), Some(9100));
        assert_eq!(parse_timecode_to_ms("6:04", 25.0), Some(364_000));
    }

    #[test]
    fn parse_timecode_mmss_50fps() {
        // "34:26" → MM:SS = 2066s → 103300 frames at 50fps
        assert_eq!(parse_timecode_to_frames("34:26", 50.0), Some(103_300));
    }

    #[test]
    fn parse_timecode_hhmmss() {
        // "01:06:04" = 1h 6m 4s = 3964s → 99100 frames at 25fps
        assert_eq!(parse_timecode_to_frames("01:06:04", 25.0), Some(99_100));
    }

    #[test]
    fn parse_timecode_hhmmssff() {
        // "00:06:04:10" = 364s + 10 frames at 25fps = 9100 + 10 = 9110
        assert_eq!(parse_timecode_to_frames("00:06:04:10", 25.0), Some(9110));
        // 50fps: 364s = 18200 frames + 10 = 18210
        assert_eq!(parse_timecode_to_frames("00:06:04:10", 50.0), Some(18_210));
    }

    #[test]
    fn parse_timecode_bare_frame_count() {
        // Pure integer is treated as a frame count
        assert_eq!(parse_timecode_to_frames("18390", 50.0), Some(18_390));
    }

    #[test]
    fn parse_timecode_rejects_garbage() {
        assert_eq!(parse_timecode_to_frames("", 25.0), None);
        assert_eq!(parse_timecode_to_frames("abc", 25.0), None);
        assert_eq!(parse_timecode_to_frames("1:2:3:4:5", 25.0), None);
        assert_eq!(parse_timecode_to_frames(":04", 25.0), None);
    }

    /// The 28-minute IN/OUT scenario from the bug report: IN=6:04, OUT=34:26
    /// at 25fps must yield a ~28:22 (42550 frame) duration — not a 2-minute
    /// stub. This locks in the corrected duration math.
    #[test]
    fn timecode_duration_28min_clip_25fps() {
        let in_frames = parse_timecode_to_frames("6:04", 25.0).unwrap();
        let out_frames = parse_timecode_to_frames("34:26", 25.0).unwrap();
        let duration = out_frames - in_frames;
        assert_eq!(duration, 42_550); // 1702s * 25
        let duration_secs = duration as f64 / 25.0;
        assert!((duration_secs - 1702.0).abs() < 0.5); // ~28:22, NOT 120s
    }
}

