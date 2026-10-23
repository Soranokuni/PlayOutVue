//! Look-ahead pre-flight of the next rows (MEDIA-FALLBACK-HANDOFF AE-3).
//!
//! Every 30 s the frontend sends the rows due in the next minutes. For each:
//! the file exists under the verified media root, its size equals the
//! sidecar's `file_size_bytes` (a copy still in flight is shorter), and the
//! sidecar's `playoutvue_id` is the row's. Problems become a row badge minutes
//! before the cut instead of a failed queue at the cut. Read-only, off the
//! UI thread and bounded: it never blocks a take.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightRow {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub playoutvue_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub id: String,
    /// False when the deadline ran out before this row was looked at.
    pub checked: bool,
    pub ok: bool,
    pub reason: Option<String>,
    pub local_path: Option<String>,
}

/// The two sidecar fields the pre-flight needs; everything else is ignored.
#[derive(Debug, Default, Deserialize)]
struct SidecarIdentity {
    #[serde(default)]
    playoutvue_id: String,
    #[serde(default)]
    file_size_bytes: Option<u64>,
}

fn is_registry_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && !id.starts_with("local:") && !id.starts_with("local-subclip:")
}

fn fail(row: &PreflightRow, local: Option<&Path>, reason: String) -> PreflightResult {
    PreflightResult {
        id: row.id.clone(),
        checked: true,
        ok: false,
        reason: Some(reason),
        local_path: local.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Check one row (pure over the filesystem; see the tests).
pub fn check_row(row: &PreflightRow, media_root: &str, advertised_root: &str) -> PreflightResult {
    let path = row.path.trim();
    if path.is_empty() {
        return fail(row, None, "the row has no media file".to_string());
    }
    let relative = if advertised_root.trim().is_empty() {
        None
    } else {
        crate::media_root::strip_root(path, advertised_root)
    };
    let registry = relative.is_some() || row.playoutvue_id.as_deref().map(is_registry_id).unwrap_or(false);
    let local: PathBuf = match &relative {
        Some(rel) => {
            if media_root.trim().is_empty() {
                return fail(row, None, "no Local media path is set".to_string());
            }
            Path::new(media_root.trim()).join(rel)
        }
        None => PathBuf::from(path),
    };

    let meta = match std::fs::metadata(&local) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => return fail(row, Some(&local), format!("'{}' is not a file", local.display())),
        Err(_) => {
            let reason = match &relative {
                Some(rel) => format!("'{}' is missing from the media root '{}'", rel, media_root.trim()),
                None => format!("'{}' is missing", local.display()),
            };
            return fail(row, Some(&local), reason);
        }
    };

    if registry {
        let sidecar_path = crate::transcoder_sidecar::sidecar_path_for(&local);
        let sidecar: SidecarIdentity = match std::fs::read_to_string(&sidecar_path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(sidecar) => sidecar,
                Err(e) => return fail(row, Some(&local), format!("its sidecar does not parse: {}", e)),
            },
            Err(_) => return fail(row, Some(&local), "its sidecar is missing".to_string()),
        };
        if let Some(expected) = sidecar.file_size_bytes {
            if expected != meta.len() {
                return fail(
                    row,
                    Some(&local),
                    format!("the file is {} bytes, its sidecar says {} (copy incomplete or replaced)", meta.len(), expected),
                );
            }
        }
        if let Some(row_id) = row.playoutvue_id.as_deref().filter(|id| is_registry_id(id)) {
            if !sidecar.playoutvue_id.is_empty() && !sidecar.playoutvue_id.eq_ignore_ascii_case(row_id.trim()) {
                return fail(
                    row,
                    Some(&local),
                    format!("the file belongs to asset {}, not to this row's {}", sidecar.playoutvue_id, row_id.trim()),
                );
            }
        }
    }

    PreflightResult {
        id: row.id.clone(),
        checked: true,
        ok: true,
        reason: None,
        local_path: Some(local.to_string_lossy().into_owned()),
    }
}

/// Check rows in order until the deadline; the rest come back `checked: false`.
pub fn check_rows(rows: &[PreflightRow], media_root: &str, advertised_root: &str, deadline: Duration) -> Vec<PreflightResult> {
    let started = Instant::now();
    rows.iter()
        .map(|row| {
            if started.elapsed() >= deadline {
                PreflightResult { id: row.id.clone(), checked: false, ok: true, reason: None, local_path: None }
            } else {
                check_row(row, media_root, advertised_root)
            }
        })
        .collect()
}

#[tauri::command]
pub async fn preflight_rows(
    rows: Vec<PreflightRow>,
    media_root: String,
    advertised_root: Option<String>,
) -> Result<Vec<PreflightResult>, String> {
    let advertised = advertised_root.unwrap_or_default();
    let worker = tauri::async_runtime::spawn_blocking(move || check_rows(&rows, &media_root, &advertised, PREFLIGHT_DEADLINE));
    // A single stat on a dead share can block past the in-loop deadline.
    tokio::time::timeout(PREFLIGHT_DEADLINE + Duration::from_secs(2), worker)
        .await
        .map_err(|_| format!("Pre-flight did not finish within {} s (media root not answering?)", PREFLIGHT_DEADLINE.as_secs()))?
        .map_err(|e| format!("pre-flight worker failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("playout-preflight-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("videos")).unwrap();
        std::fs::create_dir_all(dir.join("sidecars")).unwrap();
        dir
    }

    fn publish(root: &Path, stem: &str, bytes: &[u8], sidecar: serde_json::Value) {
        std::fs::write(root.join("videos").join(format!("{}.mp4", stem)), bytes).unwrap();
        std::fs::write(root.join("sidecars").join(format!("{}.uuid.json", stem)), sidecar.to_string()).unwrap();
    }

    fn row(id: &str, path: &str, uuid: Option<&str>) -> PreflightRow {
        PreflightRow { id: id.to_string(), path: path.to_string(), playoutvue_id: uuid.map(str::to_string) }
    }

    const UUID: &str = "0b9f6a3e-6f0c-4c1e-9a55-1f2d3c4b5a69";

    #[test]
    fn a_complete_registry_file_passes() {
        let root = temp_dir("ok");
        publish(&root, "clip.a", b"12345", serde_json::json!({ "playoutvue_id": UUID, "file_size_bytes": 5 }));
        let r = check_row(&row("r1", "D:\\Mezz\\videos\\clip.a.mp4", Some(UUID)), &root.to_string_lossy(), "D:\\Mezz");
        assert!(r.ok, "{:?}", r.reason);
        assert!(r.local_path.unwrap().ends_with("clip.a.mp4"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_file_short_copy_and_foreign_sidecar_fail() {
        let root = temp_dir("bad");
        let root_s = root.to_string_lossy().into_owned();
        let missing = check_row(&row("r1", "D:/Mezz/videos/gone.mp4", Some(UUID)), &root_s, "D:/Mezz");
        assert!(!missing.ok);
        assert!(missing.reason.unwrap().contains("videos/gone.mp4"));

        publish(&root, "short", b"123", serde_json::json!({ "playoutvue_id": UUID, "file_size_bytes": 5 }));
        let short = check_row(&row("r2", "D:/Mezz/videos/short.mp4", Some(UUID)), &root_s, "D:/Mezz");
        assert!(short.reason.unwrap().contains("3 bytes"));

        publish(&root, "other", b"12345", serde_json::json!({ "playoutvue_id": "another-asset", "file_size_bytes": 5 }));
        let foreign = check_row(&row("r3", "D:/Mezz/videos/other.mp4", Some(UUID)), &root_s, "D:/Mezz");
        assert!(foreign.reason.unwrap().contains("another-asset"));

        std::fs::write(root.join("videos").join("nosidecar.mp4"), b"1").unwrap();
        let no_sidecar = check_row(&row("r4", "D:/Mezz/videos/nosidecar.mp4", Some(UUID)), &root_s, "D:/Mezz");
        assert_eq!(no_sidecar.reason.as_deref(), Some("its sidecar is missing"));

        let no_root = check_row(&row("r5", "D:/Mezz/videos/short.mp4", Some(UUID)), "", "D:/Mezz");
        assert!(!no_root.ok);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_older_sidecar_without_a_size_still_passes_on_identity() {
        let root = temp_dir("nosize");
        publish(&root, "old", b"12345", serde_json::json!({ "playoutvue_id": UUID }));
        let r = check_row(&row("r1", "D:/Mezz/videos/old.mp4", Some(UUID)), &root.to_string_lossy(), "D:/Mezz");
        assert!(r.ok, "{:?}", r.reason);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_local_file_only_has_to_exist() {
        let root = temp_dir("local");
        let file = root.join("local.mov");
        std::fs::write(&file, b"x").unwrap();
        let path = file.to_string_lossy().into_owned();
        assert!(check_row(&row("r1", &path, Some("local:abc")), "", "D:/Mezz").ok);
        assert!(!check_row(&row("r2", &format!("{}.gone", path), None), "", "").ok);
        assert!(!check_row(&row("r3", "  ", None), "", "").ok);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rows_past_the_deadline_are_reported_unchecked() {
        let rows = vec![row("a", "x", None), row("b", "y", None)];
        let results = check_rows(&rows, "", "", Duration::ZERO);
        assert!(results.iter().all(|r| !r.checked && r.ok));
        let results = check_rows(&rows, "", "", Duration::from_secs(5));
        assert!(results.iter().all(|r| r.checked && !r.ok));
    }
}
