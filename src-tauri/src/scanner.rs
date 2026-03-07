use std::process::Command;
use std::path::PathBuf;
use std::sync::Mutex;
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

// ── Managed state wrapper ─────────────────────────────────────────────────────

pub struct DbState(pub Mutex<MediaDb>);

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
}

#[derive(Deserialize, Debug)]
struct FormatInfo {
    duration: Option<String>,
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
    let duration_secs = parsed.format.duration.as_deref().unwrap_or("0").parse::<f64>().unwrap_or(0.0);

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

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Probe a single file, using DB cache when valid.
#[tauri::command]
pub async fn scan_media(
    filepath: String,
    db_state: State<'_, DbState>,
) -> Result<MediaMetadata, String> {
    let ffprobe = get_ffprobe_path();

    // Try cache first
    {
        let db = db_state.0.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = db.get_valid(&filepath) {
            let dur_secs = cached.duration_ms as f64 / 1000.0;
            return Ok(MediaMetadata {
                filepath: cached.path,
                codec_name: cached.codec,
                width:  Some(cached.width as u32),
                height: Some(cached.height as u32),
                r_frame_rate: format!("{}/{}", cached.fps_num, cached.fps_den),
                duration: dur_secs.to_string(),
            });
        }
    }

    // Cache miss → probe
    let entry = run_ffprobe(&ffprobe, &filepath)?;
    let dur_secs = entry.duration_ms as f64 / 1000.0;
    let meta = MediaMetadata {
        filepath: entry.path.clone(),
        codec_name: entry.codec.clone(),
        width:  Some(entry.width as u32),
        height: Some(entry.height as u32),
        r_frame_rate: format!("{}/{}", entry.fps_num, entry.fps_den),
        duration: dur_secs.to_string(),
    };

    // Write to cache (ignore failures)
    if let Ok(db) = db_state.0.lock() {
        let _ = db.upsert(&entry);
    }

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
                if file_path != *root {
                    let path_str = file_path.to_string_lossy().into_owned().replace('\\', "/");
                    results.push(DiscoveredMedia {
                        filename: file_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                        path: path_str,
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

            if !["mp4","mkv","mov","mxf","avi","webm","ts","m2ts"].contains(&ext.as_str()) {
                continue;
            }

            let path_str = file_path.to_string_lossy().into_owned();
            let path_fwd = path_str.replace('\\', "/"); // normalise for frontend

            // Try cache
            let cached = {
                let db = db_state.0.lock().map_err(|e| e.to_string())?;
                db.get_valid(&path_str)
            };

            let entry_meta = if let Some(c) = cached {
                c
            } else {
                // Probe and cache
                match run_ffprobe(ffprobe, &path_str) {
                    Ok(e) => {
                        if let Ok(db) = db_state.0.lock() {
                            let _ = db.upsert(&e);
                        }
                        e
                    }
                    Err(_) => CachedMediaEntry {
                        path: path_str.clone(),
                        duration_ms: 0,
                        width: 0, height: 0,
                        codec: String::new(),
                        fps_num: 25, fps_den: 1,
                        timecode_start: "00:00:00:00".to_string(),
                    },
                }
            };

            results.push(DiscoveredMedia {
                filename: file_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                path: path_fwd,
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
