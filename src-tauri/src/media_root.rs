//! One media root, agreed and verified (MEDIA-FALLBACK-HANDOFF.md AE-1, A1/Q4).
//!
//! The transcoder advertises its root (`GET /api/v2/media-root`, contract C1)
//! and the registry marker it stamped into that folder. PlayOut reads the
//! marker in the folder *it* sees as *Local media path* and compares:
//!
//! * `strong`: the marker's `registry_id` is the advertised one (or, with the
//!   transcoder offline, the one verified earlier);
//! * `weak`: an older transcoder without C1; the marker's `data_dir` matches
//!   `/api/diagnostics` `system.data_dir`;
//! * `mismatch`: the folder belongs to another registry;
//! * `missing`: no marker (wrong folder, or a share that is not reachable);
//! * `unknown`: no transcoder and nothing verified before (local library).
//!
//! It also reads CasparCG's `<media-path>` and offers to rewrite it (backup
//! first, never while on air, then an engine restart).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::ingestor_api::{fetch_media_root, ingestor_is_loopback, MediaRootAdvert, MediaRootFetch, MEDIA_ROOT_MARKER_FILE};

/// Every filesystem look here may hit a dead SMB share; bound it.
const FS_DEADLINE: Duration = Duration::from_secs(5);

/// Prefix of resolver errors the frontend must not paper over with a guess.
pub const MEDIA_ROOT_ERROR_PREFIX: &str = "[media-root]";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MarkerInfo {
    #[serde(default)]
    pub registry_id: String,
    #[serde(default)]
    pub data_dir: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verified {
    Strong,
    Weak,
    Mismatch,
    Missing,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaRootStatus {
    pub advertised: Option<MediaRootAdvert>,
    pub transcoder_error: Option<String>,
    /// The transcoder URL is loopback.
    pub transcoder_local: bool,
    /// Loopback transcoder whose `target_folder` exists on this PC: the folder
    /// to propose as *Local media path*.
    pub proposal: Option<String>,
    pub local_root: String,
    pub local_root_exists: bool,
    pub marker: Option<MarkerInfo>,
    pub verified: Verified,
    pub caspar_config_path: Option<String>,
    /// `<media-path>` resolved against the config's folder.
    pub caspar_media_path: Option<String>,
    /// `None` when the config could not be read.
    pub caspar_matches: Option<bool>,
}

/// Lower-case, forward slashes, no verbatim prefix, no trailing slash.
pub fn normalize_root(path: &str) -> String {
    let mut s = path.trim().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        s = format!("//{}", rest);
    } else if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    let trimmed = s.trim_end_matches('/');
    // Keep a bare drive root as `d:` (and `/` as empty).
    trimmed.to_lowercase()
}

/// Same folder, whatever the spelling (case, separators, trailing slash).
/// Falls back to canonical paths when both exist (8.3 names, `.` segments).
pub fn same_folder(a: &str, b: &str) -> bool {
    if a.trim().is_empty() || b.trim().is_empty() {
        return false;
    }
    if normalize_root(a) == normalize_root(b) {
        return true;
    }
    match (std::fs::canonicalize(a.trim()), std::fs::canonicalize(b.trim())) {
        (Ok(ca), Ok(cb)) => normalize_root(&ca.to_string_lossy()) == normalize_root(&cb.to_string_lossy()),
        _ => false,
    }
}

/// `path` minus `root`, case-insensitive and separator-agnostic, with forward
/// slashes. `None` when `path` is not inside `root`.
pub fn strip_root(path: &str, root: &str) -> Option<String> {
    let root_norm = normalize_root(root);
    if root_norm.is_empty() {
        return None;
    }
    let mut source = path.trim().replace('\\', "/");
    if let Some(rest) = source.strip_prefix("//?/UNC/") {
        source = format!("//{}", rest);
    } else if let Some(rest) = source.strip_prefix("//?/") {
        source = rest.to_string();
    }
    if source.len() <= root_norm.len() || !source.is_char_boundary(root_norm.len()) {
        return None;
    }
    let (head, tail) = source.split_at(root_norm.len());
    if head.to_lowercase() != root_norm || !tail.starts_with('/') {
        return None;
    }
    let relative = tail.trim_start_matches('/');
    if relative.is_empty() || relative.split('/').any(|seg| seg == "..") {
        return None;
    }
    Some(relative.to_string())
}

/// Read the registry marker in `root`. `Ok(None)` when there is none;
/// an unreadable or malformed marker is `Ok(None)` too (it proves nothing).
pub fn read_marker(root: &Path) -> Option<MarkerInfo> {
    let raw = std::fs::read_to_string(root.join(MEDIA_ROOT_MARKER_FILE)).ok()?;
    let marker: MarkerInfo = serde_json::from_str(&raw).ok()?;
    if marker.registry_id.trim().is_empty() && marker.data_dir.trim().is_empty() {
        return None;
    }
    Some(marker)
}

/// The verification rule (pure; see the module docs).
pub fn classify(advert: Option<&MediaRootAdvert>, marker: Option<&MarkerInfo>, known_registry_id: &str) -> Verified {
    let known = known_registry_id.trim();
    match (advert, marker) {
        (None, None) => {
            if known.is_empty() { Verified::Unknown } else { Verified::Missing }
        }
        (Some(_), None) => Verified::Missing,
        (Some(advert), Some(marker)) if advert.source == "diagnostics" => {
            if !advert.data_dir.trim().is_empty() && normalize_root(&advert.data_dir) == normalize_root(&marker.data_dir) {
                Verified::Weak
            } else {
                Verified::Mismatch
            }
        }
        (Some(advert), Some(marker)) => {
            if advert.registry_id == marker.registry_id { Verified::Strong } else { Verified::Mismatch }
        }
        (None, Some(marker)) => {
            if known.is_empty() {
                Verified::Unknown
            } else if marker.registry_id == known {
                Verified::Strong
            } else {
                Verified::Mismatch
            }
        }
    }
}

/// `<media-path>` of a config file, made absolute against the config's folder
/// (CasparCG resolves a relative media path against its working directory,
/// which the supervisor sets to the executable's folder, where the config is).
pub fn caspar_media_dir(config_path: &Path, xml: &str) -> Option<String> {
    let config: crate::caspar_config::CasparConfiguration = quick_xml::de::from_str(xml).ok()?;
    let raw = config.paths.media_path?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let as_path = PathBuf::from(&raw);
    let looks_absolute = as_path.is_absolute() || raw.starts_with("\\\\") || raw.starts_with("//") || raw.contains(':');
    let full = if looks_absolute {
        raw
    } else {
        let base = config_path.parent().unwrap_or_else(|| Path::new("."));
        base.join(raw.trim_start_matches("./")).to_string_lossy().into_owned()
    };
    Some(full.replace('\\', "/"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Rewrite only `<paths><media-path>` (kebab-case, or the snake/camel spellings
/// older wizards wrote) and leave every other byte of the file alone. Inserts
/// the element when `<paths>` has none. The result is parsed back to prove it.
pub fn rewrite_media_path(xml: &str, new_root: &str) -> Result<String, String> {
    let mut value = new_root.trim().replace('\\', "/");
    if value.is_empty() {
        return Err("The media root is empty".to_string());
    }
    if !value.ends_with('/') {
        value.push('/');
    }
    let escaped = xml_escape(&value);

    let paths_re = regex::Regex::new(r"(?s)(<paths\b[^>]*>)(.*?)(</paths\s*>)").map_err(|e| e.to_string())?;
    let caps = paths_re
        .captures(xml)
        .ok_or_else(|| "casparcg.config has no <paths> section".to_string())?;
    let whole = caps.get(0).unwrap();
    let open = caps.get(1).unwrap().as_str();
    let inner = caps.get(2).unwrap().as_str();
    let close = caps.get(3).unwrap().as_str();

    let element_re = regex::Regex::new(
        r"(?s)<(media-path|media_path|mediaPath)\s*/>|<(media-path|media_path|mediaPath)\s*>.*?</(?:media-path|media_path|mediaPath)\s*>",
    )
    .map_err(|e| e.to_string())?;
    let new_inner = if let Some(m) = element_re.find(inner) {
        format!("{}<media-path>{}</media-path>{}", &inner[..m.start()], escaped, &inner[m.end()..])
    } else {
        let indent = inner
            .lines()
            .nth(1)
            .map(|line| line.chars().take_while(|c| c.is_whitespace()).collect::<String>())
            .unwrap_or_else(|| "        ".to_string());
        let eol = if xml.contains("\r\n") { "\r\n" } else { "\n" };
        format!("{}{}<media-path>{}</media-path>{}", eol, indent, escaped, inner)
    };
    let out = format!("{}{}{}{}{}", &xml[..whole.start()], open, new_inner, close, &xml[whole.end()..]);

    let parsed: crate::caspar_config::CasparConfiguration = quick_xml::de::from_str(&out)
        .map_err(|e| format!("The rewritten casparcg.config does not parse: {}", e))?;
    if parsed.paths.media_path.as_deref() != Some(value.as_str()) {
        return Err("The rewritten casparcg.config does not carry the new media path".to_string());
    }
    Ok(out)
}

/// `casparcg.config.bak-YYYYMMDD-HHMMSS` next to the config, in the PC's
/// local time (the time on the operator's clock): `offset_min` is local
/// minus UTC, from [`local_utc_offset_minutes`].
pub fn backup_path_for(config_path: &Path, epoch_ms: i64, offset_min: i32) -> PathBuf {
    let local_ms = epoch_ms + i64::from(offset_min) * 60_000;
    let date = crate::caspar_fork::utc_date(local_ms).replace('-', "");
    let secs = local_ms.div_euclid(1000).rem_euclid(86_400);
    let stamp = format!("{}-{:02}{:02}{:02}", date, secs / 3600, (secs / 60) % 60, secs % 60);
    let name = config_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "casparcg.config".to_string());
    config_path.with_file_name(format!("{}.bak-{}", name, stamp))
}

/// Local time minus UTC at `epoch_ms`, in minutes (DST included).
pub fn local_utc_offset_minutes(epoch_ms: i64) -> i32 {
    use chrono::{Local, Offset, TimeZone};
    Local
        .timestamp_millis_opt(epoch_ms)
        .single()
        .map(|t| t.offset().fix().local_minus_utc() / 60)
        .unwrap_or(0)
}

/// Strict CasparCG path for a registry asset (AE-1 resolver): `current_path`
/// minus the advertised `target_folder`, which must exist under the local
/// media root. `None` when `path` is not inside the advertised root (a local
/// file: the caller keeps its old rules).
pub fn registry_relative_path(path: &str, media_root: &str, advertised_root: &str) -> Option<Result<String, String>> {
    let relative = strip_root(path, advertised_root)?;
    if media_root.trim().is_empty() {
        return Some(Err(format!(
            "{} '{}' is a transcoder asset but no Local media path is set. Set it in Settings > Media and verify it.",
            MEDIA_ROOT_ERROR_PREFIX, relative
        )));
    }
    let local = Path::new(media_root.trim()).join(&relative);
    if local.is_file() {
        Some(Ok(relative))
    } else {
        Some(Err(format!(
            "{} '{}' is not under the Local media path '{}' (the transcoder publishes to '{}'). \
             Check Settings > Media: the folder must be the transcoder's media root as this PC sees it.",
            MEDIA_ROOT_ERROR_PREFIX,
            relative,
            media_root.trim().replace('\\', "/"),
            advertised_root.trim().replace('\\', "/")
        )))
    }
}

struct LocalLook {
    exists: bool,
    marker: Option<MarkerInfo>,
    proposal: Option<String>,
    config_path: Option<String>,
    caspar_media_path: Option<String>,
}

fn look_locally(local_root: &str, proposal_candidate: Option<String>, config_path: Option<PathBuf>) -> LocalLook {
    let root = PathBuf::from(local_root.trim());
    let exists = !local_root.trim().is_empty() && root.is_dir();
    let marker = if exists { read_marker(&root) } else { None };
    let proposal = proposal_candidate.filter(|p| !p.trim().is_empty() && Path::new(p.trim()).is_dir());
    let (config_path_str, caspar_media_path) = match config_path {
        Some(path) if path.is_file() => {
            let media = std::fs::read_to_string(&path).ok().and_then(|xml| caspar_media_dir(&path, &xml));
            (Some(path.to_string_lossy().into_owned()), media)
        }
        Some(path) => (Some(path.to_string_lossy().into_owned()), None),
        None => (None, None),
    };
    LocalLook { exists, marker, proposal, config_path: config_path_str, caspar_media_path }
}

/// AE-1 status. `local_root` is the operator's *Local media path* (or a
/// candidate being verified); `known_registry_id` the one verified before.
#[tauri::command]
pub async fn media_root_status<R: Runtime>(
    app: AppHandle<R>,
    local_root: String,
    known_registry_id: Option<String>,
) -> Result<MediaRootStatus, String> {
    let (advertised, transcoder_error) = match fetch_media_root(&app).await {
        MediaRootFetch::Advertised(advert) => (Some(advert), None),
        MediaRootFetch::Unavailable(error) => (None, Some(error)),
    };
    let transcoder_local = ingestor_is_loopback(&app);
    let proposal_candidate = if transcoder_local {
        advertised.as_ref().map(|a| a.target_folder.clone())
    } else {
        None
    };
    let config_path = crate::caspar_config::engine_config_path(&app).ok();

    let root_for_look = local_root.clone();
    let look = tokio::time::timeout(
        FS_DEADLINE,
        tauri::async_runtime::spawn_blocking(move || look_locally(&root_for_look, proposal_candidate, config_path)),
    )
    .await
    .map_err(|_| format!("The media folder '{}' did not answer within {} s", local_root, FS_DEADLINE.as_secs()))?
    .map_err(|e| format!("media-root worker failed: {}", e))?;

    let verified = classify(advertised.as_ref(), look.marker.as_ref(), known_registry_id.as_deref().unwrap_or(""));
    let caspar_matches = look
        .caspar_media_path
        .as_ref()
        .map(|caspar| look.exists && same_folder(caspar, &local_root));
    Ok(MediaRootStatus {
        advertised,
        transcoder_error,
        transcoder_local,
        proposal: look.proposal,
        local_root,
        local_root_exists: look.exists,
        marker: look.marker,
        verified,
        caspar_config_path: look.config_path,
        caspar_media_path: look.caspar_media_path,
        caspar_matches,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaPathFix {
    pub config_path: String,
    pub backup_path: String,
    pub media_path: String,
    pub restarted: bool,
    pub restart_error: Option<String>,
}

fn write_media_path_fix(config_path: &Path, root: &str, epoch_ms: i64, offset_min: i32) -> Result<(PathBuf, String), String> {
    let xml = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Cannot read '{}': {}", config_path.display(), e))?;
    let rewritten = rewrite_media_path(&xml, root)?;
    let backup = backup_path_for(config_path, epoch_ms, offset_min);
    std::fs::copy(config_path, &backup)
        .map_err(|e| format!("Cannot back up '{}' to '{}': {}", config_path.display(), backup.display(), e))?;
    crate::atomic_fs::write_atomic(config_path, rewritten.as_bytes())
        .map_err(|e| format!("Cannot write '{}': {}", config_path.display(), e))?;
    let media = caspar_media_dir(config_path, &rewritten).unwrap_or_default();
    Ok((backup, media))
}

/// Q4: point CasparCG's `<media-path>` at the verified root. Refused while
/// anything is on air (the frontend's `on_air` includes fillers, the Rust
/// playback state covers a registered clip); the engine restart follows.
#[tauri::command]
pub async fn fix_caspar_media_path<R: Runtime>(
    app: AppHandle<R>,
    root: String,
    on_air: bool,
    playback: State<'_, crate::caspar::CasparPlaybackState>,
    supervisor: State<'_, crate::caspar_process::CasparProcessSupervisor>,
    settings_state: State<'_, crate::runtime_settings::RuntimeSettingsState>,
) -> Result<MediaPathFix, String> {
    let rust_on_air = {
        let state = playback.0.lock();
        state.is_playing || state.current_uuid.is_some()
    };
    if on_air || rust_on_air {
        return Err("Refused: the channel is on air. Stop playback, then fix the CasparCG media path.".to_string());
    }
    let root_check = root.clone();
    let root_ok = tokio::time::timeout(
        FS_DEADLINE,
        tauri::async_runtime::spawn_blocking(move || Path::new(root_check.trim()).is_dir()),
    )
    .await
    .map(|r| r.unwrap_or(false))
    .unwrap_or(false);
    if !root_ok {
        return Err(format!("The media root '{}' is not a reachable folder", root.trim()));
    }
    let config_path = crate::caspar_config::engine_config_path(&app)?;
    if !config_path.is_file() {
        return Err(format!("CasparCG config '{}' not found", config_path.display()));
    }
    let epoch_ms = crate::recovery::now_epoch_ms() as i64;
    let path_for_write = config_path.clone();
    let root_for_write = root.clone();
    let (backup, media_path) = tauri::async_runtime::spawn_blocking(move || {
        write_media_path_fix(&path_for_write, &root_for_write, epoch_ms, local_utc_offset_minutes(epoch_ms))
    })
    .await
    .map_err(|e| format!("config worker failed: {}", e))??;
    log::info!(
        "[MediaRoot] casparcg.config media path set to '{}' (backup '{}')",
        media_path,
        backup.display()
    );

    let settings = settings_state.snapshot();
    let restart = supervisor.restart(&app, &settings).await;
    Ok(MediaPathFix {
        config_path: config_path.to_string_lossy().into_owned(),
        backup_path: backup.to_string_lossy().into_owned(),
        media_path,
        restarted: restart.is_ok(),
        restart_error: restart.err(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn advert(id: &str) -> MediaRootAdvert {
        crate::ingestor_api::parse_media_root_v2(&format!(r#"{{"registry_id":"{}","target_folder":"D:/Mezz"}}"#, id)).unwrap()
    }

    fn marker(id: &str, data_dir: &str) -> MarkerInfo {
        MarkerInfo { registry_id: id.to_string(), data_dir: data_dir.to_string() }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("playout-media-root-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classify_covers_every_case() {
        let a = advert("reg-a");
        assert_eq!(classify(Some(&a), Some(&marker("reg-a", "x")), ""), Verified::Strong);
        assert_eq!(classify(Some(&a), Some(&marker("reg-b", "x")), ""), Verified::Mismatch);
        assert_eq!(classify(Some(&a), None, ""), Verified::Missing);
        // Transcoder offline: the id verified before still proves the folder.
        assert_eq!(classify(None, Some(&marker("reg-a", "x")), "reg-a"), Verified::Strong);
        assert_eq!(classify(None, Some(&marker("reg-b", "x")), "reg-a"), Verified::Mismatch);
        assert_eq!(classify(None, None, "reg-a"), Verified::Missing);
        assert_eq!(classify(None, None, ""), Verified::Unknown);
        assert_eq!(classify(None, Some(&marker("reg-a", "x")), ""), Verified::Unknown);

        let weak = crate::ingestor_api::parse_media_root_from_diagnostics(
            r#"{"system":{"data_dir":"C:\\ProgramData\\PT"},"config_summary":{"target_folder":"D:/Mezz"}}"#,
        )
        .unwrap();
        assert_eq!(classify(Some(&weak), Some(&marker("whatever", "c:/programdata/pt/")), ""), Verified::Weak);
        assert_eq!(classify(Some(&weak), Some(&marker("whatever", "C:/Other")), ""), Verified::Mismatch);
        assert_eq!(classify(Some(&weak), None, ""), Verified::Missing);
    }

    #[test]
    fn strip_root_is_case_and_separator_agnostic() {
        assert_eq!(strip_root("D:\\Mezz\\videos\\a.mxf", "d:/mezz/").as_deref(), Some("videos/a.mxf"));
        assert_eq!(strip_root("\\\\?\\D:\\Mezz\\videos\\a.mxf", "D:\\MEZZ").as_deref(), Some("videos/a.mxf"));
        assert_eq!(strip_root("\\\\TX01\\Mezz\\videos\\a.mxf", "//tx01/mezz").as_deref(), Some("videos/a.mxf"));
        // A sibling folder that shares the prefix is not inside the root.
        assert_eq!(strip_root("D:/Mezz2/videos/a.mxf", "D:/Mezz"), None);
        assert_eq!(strip_root("D:/Mezz", "D:/Mezz"), None);
        assert_eq!(strip_root("D:/Mezz/../x.mxf", "D:/Mezz"), None);
        assert_eq!(strip_root("E:/Other/a.mxf", "D:/Mezz"), None);
        assert_eq!(strip_root("D:/Mezz/a.mxf", ""), None);
    }

    #[test]
    fn registry_paths_resolve_strictly_against_the_local_root() {
        let root = temp_dir("resolve");
        std::fs::create_dir_all(root.join("videos")).unwrap();
        std::fs::write(root.join("videos").join("a.mxf"), b"x").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        // The transcoder's own view of the folder differs from this PC's.
        let ok = registry_relative_path("D:\\Mezz\\videos\\a.mxf", &root_str, "D:\\Mezz").unwrap();
        assert_eq!(ok.unwrap(), "videos/a.mxf");

        let missing = registry_relative_path("D:\\Mezz\\videos\\gone.mxf", &root_str, "D:\\Mezz").unwrap();
        let message = missing.unwrap_err();
        assert!(message.starts_with(MEDIA_ROOT_ERROR_PREFIX));
        assert!(message.contains("videos/gone.mxf"));

        let unset = registry_relative_path("D:\\Mezz\\videos\\a.mxf", "", "D:\\Mezz").unwrap();
        assert!(unset.unwrap_err().starts_with(MEDIA_ROOT_ERROR_PREFIX));

        // Not a registry path: the caller keeps its own rules.
        assert!(registry_relative_path("C:/Local/clip.mp4", &root_str, "D:\\Mezz").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn marker_is_read_from_the_folder() {
        let root = temp_dir("marker");
        assert_eq!(read_marker(&root), None);
        std::fs::write(
            root.join(MEDIA_ROOT_MARKER_FILE),
            r#"{"registry_id":"reg-a","data_dir":"C:\\PT","claimed_at":"2026","service_version":"1"}"#,
        )
        .unwrap();
        assert_eq!(read_marker(&root), Some(marker("reg-a", "C:\\PT")));
        std::fs::write(root.join(MEDIA_ROOT_MARKER_FILE), "{not json").unwrap();
        assert_eq!(read_marker(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    const CONFIG_KEBAB: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<configuration>\r\n    <paths>\r\n        <media-path>media/</media-path>\r\n        <log-path disable=\"false\">log/</log-path>\r\n        <template-path>template/</template-path>\r\n    </paths>\r\n    <!-- operator comment -->\r\n    <channels><channel><video-mode>1080i5000</video-mode></channel></channels>\r\n</configuration>\r\n";

    #[test]
    fn rewrite_changes_only_the_media_path() {
        let out = rewrite_media_path(CONFIG_KEBAB, "D:\\Mezz").unwrap();
        assert!(out.contains("<media-path>D:/Mezz/</media-path>"));
        assert!(out.contains("<log-path disable=\"false\">log/</log-path>"));
        assert!(out.contains("<!-- operator comment -->"));
        assert_eq!(out.replace("<media-path>D:/Mezz/</media-path>", "<media-path>media/</media-path>"), CONFIG_KEBAB);
    }

    #[test]
    fn rewrite_accepts_legacy_spellings_and_inserts_when_absent() {
        let snake = "<configuration><paths><media_path>old/</media_path></paths></configuration>";
        let out = rewrite_media_path(snake, "//TX01/Mezz/").unwrap();
        assert!(out.contains("<media-path>//TX01/Mezz/</media-path>"));
        assert!(!out.contains("media_path"));

        let absent = "<configuration>\n  <paths>\n    <log-path>log/</log-path>\n  </paths>\n</configuration>";
        let out = rewrite_media_path(absent, "E:/M").unwrap();
        assert!(out.contains("<media-path>E:/M/</media-path>"));
        assert!(out.contains("<log-path>log/</log-path>"));

        assert!(rewrite_media_path("<configuration/>", "E:/M").is_err());
        assert!(rewrite_media_path(CONFIG_KEBAB, "  ").is_err());
        // XML metacharacters in a folder name stay one value.
        let out = rewrite_media_path(CONFIG_KEBAB, "D:/R&D").unwrap();
        assert!(out.contains("<media-path>D:/R&amp;D/</media-path>"));
    }

    #[test]
    fn media_dir_is_resolved_against_the_config_folder() {
        let cfg = Path::new("D:/casparcg/casparcg.config");
        assert_eq!(caspar_media_dir(cfg, CONFIG_KEBAB).as_deref(), Some("D:/casparcg/media/"));
        let abs = CONFIG_KEBAB.replace("media/", "E:\\Mezz\\");
        assert_eq!(caspar_media_dir(cfg, &abs).as_deref(), Some("E:/Mezz/"));
        assert!(same_folder("D:/casparcg/media/", "d:\\CasparCG\\Media"));
        assert!(!same_folder("D:/casparcg/media2", "D:/casparcg/media"));
        assert!(!same_folder("", "D:/x"));
    }

    #[test]
    fn fix_writes_a_backup_and_the_new_path() {
        let dir = temp_dir("fix");
        let cfg = dir.join("casparcg.config");
        std::fs::write(&cfg, CONFIG_KEBAB).unwrap();
        let epoch_ms = 1_792_144_800_000; // 2026-10-16T10:00:00Z
        // Athens summer time, UTC+3: the name carries the operator's clock.
        let (backup, media) = write_media_path_fix(&cfg, "D:/Mezz", epoch_ms, 180).unwrap();
        assert_eq!(backup.file_name().unwrap().to_string_lossy(), "casparcg.config.bak-20261016-130000");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), CONFIG_KEBAB);
        assert_eq!(media, "D:/Mezz/");
        assert!(std::fs::read_to_string(&cfg).unwrap().contains("<media-path>D:/Mezz/</media-path>"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
