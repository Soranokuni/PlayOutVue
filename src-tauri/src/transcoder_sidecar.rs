use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};

use crate::runtime_settings::RuntimeSettingsState;
use crate::scanner::DbState;

/// Describes the original source media that was transcoded.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct OriginalSource {
    pub path: String,
    pub codec: String,
    pub duration_secs: f64,
    pub frame_count: i64,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub fps_num: i64,
    pub fps_den: i64,
    pub field_order: String,
}

/// Describes the transcoded output media parameters.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct OutputMedia {
    pub duration_secs: f64,
    pub frame_count: i64,
    pub width: i64,
    pub height: i64,
    pub codec: String,
    pub audio_codec: String,
    pub audio_sample_rate: i64,
    pub audio_channels: i64,
    pub fps_num: i64,
    pub fps_den: i64,
}

/// The complete transcoder sidecar JSON written next to each transcoded file.
/// File name convention: `<basename>.<uuid>.uuid.json` sitting beside
/// `<basename>.<uuid>.mp4`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct TranscoderSidecar {
    pub playoutvue_id: String,
    pub id: String,
    pub path: String,
    pub duration_ms: i64,
    pub trim_in_ms: i64,
    pub trim_out_ms: i64,
    pub fps_num: i64,
    pub fps_den: i64,
    pub mezzanine_ok: bool,
    pub filename: String,
    pub filepath: String,
    pub transcoded_at: String,
    pub profile_used: String,
    pub original_source: OriginalSource,
    pub output_media: OutputMedia,
    pub fps: f64,
    pub total_frames: i64,
    pub gop_frames: i64,
    pub keyframe_safe_start_ms: i64,
    pub warnings: Vec<String>,
}

/// QC verdict derived from the sidecar. An asset is playback-ready only when
/// `mezzanine_ok` is true AND there are no critical warnings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct QcVerdict {
    pub ready: bool,
    pub mezzanine_ok: bool,
    pub warnings: Vec<String>,
    pub transcoded_at: String,
    pub profile_used: String,
    pub has_sidecar: bool,
}


/// Compute the sidecar JSON path for a given media file path.
///
/// Looks in the following locations in order:
/// 1. Sibling `sidecars/` folder: if media is in `.../videos/`, checks `.../sidecars/<stem>.uuid.json`
/// 2. Subfolder `sidecars/`: `<parent>/sidecars/<stem>.uuid.json`
/// 3. Adjacent legacy location: `<parent>/<stem>.uuid.json`
pub fn sidecar_path_for(media_path: &Path) -> PathBuf {
    let sidecar_filename = match media_path.file_stem() {
        Some(stem) => format!("{}.uuid.json", stem.to_string_lossy()),
        None => "metadata.uuid.json".to_string(),
    };

    if let Some(parent) = media_path.parent() {
        // 1. If media_path is in a "videos" directory: check sibling sidecars/ folder
        if parent.file_name().map(|n| n == "videos").unwrap_or(false) {
            if let Some(grandparent) = parent.parent() {
                let sidecars_sibling = grandparent.join("sidecars").join(&sidecar_filename);
                if sidecars_sibling.exists() {
                    return sidecars_sibling;
                }
                let legacy_adjacent = media_path.with_extension("uuid.json");
                if legacy_adjacent.exists() {
                    return legacy_adjacent;
                }
                return sidecars_sibling;
            }
        }

        // 2. Check if subfolder <parent>/sidecars/<sidecar_filename> exists:
        let sidecars_subfolder = parent.join("sidecars").join(&sidecar_filename);
        if sidecars_subfolder.exists() {
            return sidecars_subfolder;
        }

        let legacy_adjacent = media_path.with_extension("uuid.json");
        return legacy_adjacent;
    }

    media_path.with_extension("uuid.json")
}

/// Read and parse the transcoder sidecar JSON for a given media file.
/// Returns `None` if the sidecar does not exist or fails to parse.
pub fn read_sidecar(media_path: &Path) -> Option<TranscoderSidecar> {
    if !media_path.is_file() {
        return None;
    }

    let sidecar_path = sidecar_path_for(media_path);
    let content = match std::fs::read_to_string(&sidecar_path) {
        Ok(content) => content,
        Err(_) => return None,
    };

    match serde_json::from_str::<TranscoderSidecar>(&content) {
        Ok(sidecar) => Some(sidecar),
        Err(error) => {
            log::warn!(
                "[transcoder_sidecar] Failed to parse '{}': {}",
                sidecar_path.display(),
                error
            );
            None
        }
    }
}

/// Determine whether a sidecar indicates the asset passed QC.
/// An asset passes when `mezzanine_ok` is true and there are no warnings
/// containing "critical" or "error".
pub fn is_qc_passed(sidecar: &TranscoderSidecar) -> bool {
    if !sidecar.mezzanine_ok {
        return false;
    }

    !sidecar
        .warnings
        .iter()
        .any(|w| w.to_lowercase().contains("critical") || w.to_lowercase().contains("error"))
}

/// Build a QcVerdict from a media file path by reading its sidecar.
pub fn qc_verdict_for(media_path: &Path) -> QcVerdict {
    match read_sidecar(media_path) {
        Some(sidecar) => QcVerdict {
            ready: is_qc_passed(&sidecar),
            mezzanine_ok: sidecar.mezzanine_ok,
            warnings: sidecar.warnings.clone(),
            transcoded_at: sidecar.transcoded_at.clone(),
            profile_used: sidecar.profile_used.clone(),
            has_sidecar: true,
        },
        None => QcVerdict::default(),
    }
}

/// The asset uuid a sidecar belongs to: `playoutvue_id`, else `id`.
pub fn sidecar_asset_id(sidecar: &TranscoderSidecar) -> &str {
    if !sidecar.playoutvue_id.is_empty() {
        &sidecar.playoutvue_id
    } else {
        &sidecar.id
    }
}

/// TRIM-CONTRACT-AUDIT C-12: the transcoder rewrites a full-length asset's
/// sidecar trim when it is changed, so a cached entry takes the sidecar's
/// window on every scan. Only when the sidecar belongs to the entry's asset
/// and `0 <= in < out <= duration_ms`; otherwise the cached trim stays.
///
/// The cache is keyed by path and sub-clips share their parent's path (C-1):
/// this is the parent's library trim only, never a rundown row's or a
/// sub-clip's. Returns whether the entry changed.
pub fn refresh_trim_from_sidecar(
    entry: &mut crate::db::CachedMediaEntry,
    sidecar: &TranscoderSidecar,
) -> bool {
    let sidecar_id = sidecar_asset_id(sidecar);
    if sidecar_id.is_empty() || !entry.playoutvue_id.eq_ignore_ascii_case(sidecar_id) {
        return false;
    }
    let (trim_in, trim_out) = (sidecar.trim_in_ms, sidecar.trim_out_ms);
    if trim_in < 0 || trim_out <= trim_in || trim_out > sidecar.duration_ms {
        return false;
    }
    if entry.trim_in_ms == trim_in && entry.trim_out_ms == trim_out {
        return false;
    }
    entry.trim_in_ms = trim_in;
    entry.trim_out_ms = trim_out;
    true
}

/// Convert a transcoder sidecar into a cached media entry suitable for DB upsert.
/// This provides reliable metadata without needing ffprobe.
pub fn sidecar_to_cached_entry(
    sidecar: &TranscoderSidecar,
    media_path: &str,
) -> crate::db::CachedMediaEntry {
    let om = &sidecar.output_media;
    let os = &sidecar.original_source;

    let fps_num = if om.fps_num > 0 { om.fps_num } else { sidecar.fps_num };
    let fps_den = if om.fps_den > 0 { om.fps_den } else { sidecar.fps_den };

    crate::db::CachedMediaEntry {
        path: media_path.to_string(),
        duration_ms: sidecar.duration_ms,
        trim_in_ms: sidecar.trim_in_ms,
        trim_out_ms: sidecar.trim_out_ms,
        width: om.width,
        height: om.height,
        codec: if om.codec.is_empty() { "h264".to_string() } else { om.codec.clone() },
        fps_num,
        fps_den: if fps_den > 0 { fps_den } else { 1 },
        display_aspect_ratio: String::new(),
        field_order: if os.field_order.is_empty() { "progressive".to_string() } else { os.field_order.clone() },
        timecode_start: "00:00:00:00".to_string(),
        playoutvue_id: if !sidecar.playoutvue_id.is_empty() {
            sidecar.playoutvue_id.clone()
        } else {
            sidecar.id.clone()
        },
        transcode_profile: sidecar.profile_used.clone(),
        transcoded_at: sidecar.transcoded_at.clone(),
        original_source_path: os.path.clone(),
        mezzanine_ok: sidecar.mezzanine_ok,
        qc_warnings: sidecar.warnings.join("; "),
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Pre-flight playback readiness check. Called before sending a PLAY command
/// to CasparCG. Verifies:
///   1. The file exists on disk.
///   2. The asset has metadata in the DB (or a transcoder sidecar).
///   3. The QC verdict from the sidecar passes (mezzanine_ok + no critical warnings).
///
/// If the DB has no entry but a sidecar exists, the sidecar metadata is
/// upserted into the DB so that `compute_frame_trim` succeeds on the
/// subsequent call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackReadiness {
    pub ready: bool,
    pub file_exists: bool,
    pub has_db_entry: bool,
    pub has_sidecar: bool,
    pub qc_passed: bool,
    pub mezzanine_ok: bool,
    pub warnings: Vec<String>,
    pub duration_ms: i64,
    pub fps_num: i64,
    pub fps_den: i64,
    pub error: String,
}

#[tauri::command]
pub async fn verify_playback_ready<R: Runtime>(
    path: String,
    app: AppHandle<R>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    db_state: State<'_, DbState>,
) -> Result<PlaybackReadiness, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(PlaybackReadiness {
            ready: false,
            file_exists: false,
            has_db_entry: false,
            has_sidecar: false,
            qc_passed: false,
            mezzanine_ok: false,
            warnings: vec!["Empty path".to_string()],
            duration_ms: 0,
            fps_num: 0,
            fps_den: 0,
            error: "Empty path".to_string(),
        });
    }

    let file_path = PathBuf::from(trimmed);
    let file_exists = file_path.is_file();

    // Read the transcoder sidecar (if any)
    let sidecar = read_sidecar(&file_path);
    let has_sidecar = sidecar.is_some();

    let qc_verdict = match &sidecar {
        Some(_) => qc_verdict_for(&file_path),
        None => QcVerdict::default(),
    };

    // Check DB for existing entry (re-checked after the fallbacks below so the
    // reported duration/fps reflect whatever metadata source was resolved).
    let mut has_db_entry = db_state.0.get_entry(trimmed).is_some();

    // If no DB entry but sidecar exists, populate the DB from the sidecar
    if !has_db_entry && file_exists {
        if let Some(ref sc) = sidecar {
            let entry = sidecar_to_cached_entry(sc, trimmed);
            if let Err(e) = db_state.0.upsert(&entry) {
                log::warn!("[verify_playback_ready] DB upsert from sidecar failed: {}", e);
            } else {
                has_db_entry = true;
            }
        }
    }

    // Metadata race fallback: the ingestor copies the file into the CasparCG
    // media folder BEFORE writing the sidecar JSON, and the background scanner
    // may not have probed it yet (or may hold a stale entry from a mid-copy
    // probe). A manual take inside that window would otherwise fail the
    // pre-flight check and the rundown would skip the clip. Probe the file
    // directly and upsert the result so playback proceeds.
    if !has_db_entry && file_exists {
        let ffprobe = crate::scanner::get_ffprobe_path(Some(&app), Some(&runtime_settings));
        match crate::scanner::probe_media_metadata_async(ffprobe, trimmed.to_string()).await {
            Ok(entry) => {
                if let Err(e) = db_state.0.upsert(&entry) {
                    log::warn!("[verify_playback_ready] DB upsert from ffprobe fallback failed: {}", e);
                } else {
                    has_db_entry = true;
                }
            }
            Err(e) => {
                log::warn!("[verify_playback_ready] ffprobe fallback failed for '{}': {}", trimmed, e);
            }
        }
    }

    // Determine readiness: file exists + has metadata (DB or sidecar) + QC passed
    let has_metadata = has_db_entry || has_sidecar;
    let qc_passed = qc_verdict.ready || (!has_sidecar && has_db_entry);
    let ready = file_exists && has_metadata && qc_passed;

    let db_entry = db_state.0.get_entry(trimmed);
    let (duration_ms, fps_num, fps_den) = match &db_entry {
        Some(entry) => (entry.duration_ms, entry.fps_num, entry.fps_den),
        None => match &sidecar {
            Some(sc) => (sc.duration_ms, sc.fps_num, sc.fps_den),
            None => (0, 0, 0),
        },
    };

    let error = if !file_exists {
        format!("File not found: {}", trimmed)
    } else if !has_metadata {
        format!("No metadata available (DB entry missing, no sidecar): {}", trimmed)
    } else if !qc_passed {
        if !qc_verdict.mezzanine_ok {
            format!("QC not passed (mezzanine_ok=false): {}", trimmed)
        } else {
            format!("QC warnings contain critical errors: {}", qc_verdict.warnings.join("; "))
        }
    } else {
        String::new()
    };

    Ok(PlaybackReadiness {
        ready,
        file_exists,
        has_db_entry,
        has_sidecar,
        qc_passed,
        mezzanine_ok: qc_verdict.mezzanine_ok,
        warnings: qc_verdict.warnings.clone(),
        duration_ms,
        fps_num,
        fps_den,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSET: &str = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

    fn trimmed_sidecar(id: &str, trim_in_ms: i64, trim_out_ms: i64) -> TranscoderSidecar {
        TranscoderSidecar {
            playoutvue_id: id.to_string(),
            duration_ms: 60_000,
            trim_in_ms,
            trim_out_ms,
            mezzanine_ok: true,
            ..Default::default()
        }
    }

    fn cached_full_length(id: &str) -> crate::db::CachedMediaEntry {
        let mut entry = sidecar_to_cached_entry(&trimmed_sidecar(id, 0, 60_000), "C:/media/videos/clip.mp4");
        entry.playoutvue_id = id.to_string();
        entry
    }

    #[test]
    fn rescan_takes_a_trim_saved_after_caching() {
        let mut entry = cached_full_length(ASSET);
        let sidecar = trimmed_sidecar(&ASSET.to_uppercase(), 4_000, 50_000);
        assert!(refresh_trim_from_sidecar(&mut entry, &sidecar));
        assert_eq!((entry.trim_in_ms, entry.trim_out_ms), (4_000, 50_000));
        // Already current: nothing to write.
        assert!(!refresh_trim_from_sidecar(&mut entry, &sidecar));
    }

    #[test]
    fn rescan_falls_back_to_the_sidecar_id_field() {
        let mut entry = cached_full_length(ASSET);
        let sidecar = TranscoderSidecar { id: ASSET.to_string(), ..trimmed_sidecar("", 4_000, 50_000) };
        assert!(refresh_trim_from_sidecar(&mut entry, &sidecar));
        assert_eq!((entry.trim_in_ms, entry.trim_out_ms), (4_000, 50_000));
    }

    #[test]
    fn rescan_keeps_the_cached_trim_for_a_foreign_or_invalid_sidecar() {
        let foreign = trimmed_sidecar("0f2504e0-4f89-11d3-9a0c-0305e82c3301", 4_000, 50_000);
        let past_end = trimmed_sidecar(ASSET, 4_000, 60_001);
        let inverted = trimmed_sidecar(ASSET, 50_000, 4_000);
        let negative = trimmed_sidecar(ASSET, -1, 50_000);
        let unset = trimmed_sidecar(ASSET, 0, 0);
        for sidecar in [foreign, past_end, inverted, negative, unset] {
            let mut entry = cached_full_length(ASSET);
            assert!(!refresh_trim_from_sidecar(&mut entry, &sidecar));
            assert_eq!((entry.trim_in_ms, entry.trim_out_ms), (0, 60_000));
        }
        let mut anonymous = cached_full_length("");
        assert!(!refresh_trim_from_sidecar(&mut anonymous, &trimmed_sidecar("", 4_000, 50_000)));
    }

    #[test]
    fn sidecar_path_resolves_to_sidecars_directory() {
        let media = Path::new("C:/media/videos/clip_abc-123.mp4");
        let sidecar = sidecar_path_for(media);
        let normalized = sidecar.to_string_lossy().replace('\\', "/");
        assert_eq!(
            normalized,
            "C:/media/sidecars/clip_abc-123.uuid.json"
        );
    }

    #[test]
    fn sidecar_path_generic_folder_defaults_to_adjacent() {
        let media = Path::new("C:/media/custom_folder/clip_abc-123.mp4");
        let sidecar = sidecar_path_for(media);
        let normalized = sidecar.to_string_lossy().replace('\\', "/");
        assert_eq!(
            normalized,
            "C:/media/custom_folder/clip_abc-123.uuid.json"
        );
    }

    #[test]
    fn qc_passed_when_mezzanine_ok_and_no_warnings() {
        let sidecar = TranscoderSidecar {
            mezzanine_ok: true,
            warnings: vec![],
            ..Default::default()
        };
        assert!(is_qc_passed(&sidecar));
    }

    #[test]
    fn qc_fails_when_mezzanine_not_ok() {
        let sidecar = TranscoderSidecar {
            mezzanine_ok: false,
            warnings: vec![],
            ..Default::default()
        };
        assert!(!is_qc_passed(&sidecar));
    }

    #[test]
    fn qc_fails_with_critical_warning() {
        let sidecar = TranscoderSidecar {
            mezzanine_ok: true,
            warnings: vec!["critical: audio sync drift".to_string()],
            ..Default::default()
        };
        assert!(!is_qc_passed(&sidecar));
    }
}
