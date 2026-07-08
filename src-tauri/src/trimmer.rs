use std::path::Path;
use tauri::{AppHandle, Runtime, State};

use crate::runtime_settings::{resolve_tool_path, RuntimeSettingsState};
use crate::transcoder_sidecar;

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

#[tauri::command]
pub async fn compute_frame_trim(
    path: String,
    trim_in_ms: i64,
    trim_out_ms: i64,
    db_state: State<'_, crate::scanner::DbState>,
) -> Result<FrameTrimResult, String> {
    let entry = match db_state.0.get_entry(&path) {
        Some(entry) if entry.fps_num > 0 && entry.duration_ms > 0 => entry,
        _ => {
            // Fallback: try the transcoder sidecar JSON before erroring out.
            // This fixes the "Asset not found in database" error that occurred
            // when a newly transcoded file hadn't been scanned into the DB yet.
            let sidecar = transcoder_sidecar::read_sidecar(Path::new(&path))
                .ok_or_else(|| format!("Asset not found in database: {}", path))?;
            let mut entry = transcoder_sidecar::sidecar_to_cached_entry(&sidecar, &path);
            // Persist to DB so subsequent lookups succeed
            let _ = db_state.0.upsert(&entry);
            if entry.fps_num <= 0 || entry.duration_ms <= 0 {
                return Err(format!(
                    "Invalid metadata for asset (fps: {}/{}, duration: {}ms): {}",
                    entry.fps_num, entry.fps_den, entry.duration_ms, path
                ));
            }
            // Re-fetch to get the normalized path
            entry.path = path.clone();
            entry
        }
    };

    if entry.fps_num <= 0 || entry.fps_den <= 0 {
        return Err(format!(
            "Invalid frame rate for asset: {}/{}",
            entry.fps_num, entry.fps_den
        ));
    }

    let fps = entry.fps_num as f64 / entry.fps_den as f64;
    let total_dur = if entry.duration_ms < 0 { 0 } else { entry.duration_ms };

    // Clamp trim_in_ms between 0 and duration_ms
    let in_ms = trim_in_ms.clamp(0, total_dur);

    // Default trim_out_ms to total duration if <= 0 or > duration_ms
    let mut out_ms = if trim_out_ms <= 0 || trim_out_ms > total_dur {
        total_dur
    } else {
        trim_out_ms
    };

    if out_ms <= in_ms {
        let clamped_out = (in_ms + 2000).min(total_dur);
        if clamped_out <= in_ms {
            return Err(format!(
                "Asset has zero or invalid duration ({}ms), cannot trim: {}",
                total_dur, path
            ));
        }
        tracing::warn!(
            "Degenerate trim [{},{}] for {}, clamping out to {}",
            in_ms, out_ms, path, clamped_out
        );
        out_ms = clamped_out;
    }

    // Convert milliseconds to frame counts
    let in_frame = ((in_ms as f64 / 1000.0) * fps).floor() as u32;
    let out_frame_raw = ((out_ms as f64 / 1000.0) * fps).ceil() as u32;
    let total_frames = ((total_dur as f64 / 1000.0) * fps).round() as u32;

    // Ensure out_frame is capped at the calculated absolute total frame count of the file
    let out_frame = std::cmp::min(out_frame_raw, total_frames);

    let duration_frames = out_frame.saturating_sub(in_frame);

    Ok(FrameTrimResult {
        in_frame,
        out_frame,
        duration_frames,
        fps_rational: format!("{}/{}", entry.fps_num, entry.fps_den),
    })
}

