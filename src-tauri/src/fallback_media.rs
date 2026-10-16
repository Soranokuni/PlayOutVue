//! The fork's local fallback (MEDIA-FALLBACK-HANDOFF AE-2 / AE-4, B1 + B3).
//!
//! The fallback clip and the filler folder must survive a media-share outage
//! (Q2/T1), so they have to live on a **local** disk: UNC paths and mapped
//! network drives are refused. The self-test proves the engine will be able to
//! open them: the clip exists and probes, and at least one filler probes.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

/// Bound for a whole self-test (each probe has its own 20 s limit).
const SELF_TEST_DEADLINE: Duration = Duration::from_secs(45);

/// Video files the fork's `FALLBACK LIST` plays (non-recursive), plus stills a
/// single-clip fallback may use.
const VIDEO_EXTENSIONS: &[&str] = &[
    "mov", "mp4", "mxf", "mkv", "avi", "m4v", "mpg", "mpeg", "ts", "m2ts", "webm", "wmv",
];
const STILL_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "tga", "bmp", "tif", "tiff"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    Missing,
    Other,
}

/// UNC and `\\?\UNC\` paths are network paths whatever the drive table says.
pub fn is_unc(path: &str) -> bool {
    let p = path.trim().replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        return rest.to_ascii_uppercase().starts_with(r"UNC\");
    }
    p.starts_with(r"\\")
}

/// `D:\` for `D:/x/y`, `None` for a relative or UNC path.
pub fn drive_root(path: &str) -> Option<String> {
    let p = path.trim().trim_start_matches(r"\\?\");
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        Some(format!("{}:\\", (bytes[0] as char).to_ascii_uppercase()))
    } else {
        None
    }
}

#[cfg(windows)]
fn drive_kind_of_root(root: &str) -> DriveKind {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    // winbase.h; the constants live in a windows-sys feature this crate does not enable.
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call.
    match unsafe { GetDriveTypeW(wide.as_ptr()) } {
        DRIVE_FIXED => DriveKind::Fixed,
        DRIVE_REMOVABLE => DriveKind::Removable,
        DRIVE_REMOTE => DriveKind::Network,
        DRIVE_NO_ROOT_DIR => DriveKind::Missing,
        _ => DriveKind::Other,
    }
}

#[cfg(not(windows))]
fn drive_kind_of_root(_root: &str) -> DriveKind {
    DriveKind::Fixed
}

pub fn drive_kind(path: &str) -> DriveKind {
    if is_unc(path) {
        return DriveKind::Network;
    }
    match drive_root(path) {
        Some(root) => drive_kind_of_root(&root),
        None => DriveKind::Other,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LocalPathCheck {
    pub local: bool,
    pub kind: DriveKind,
    pub reason: Option<String>,
}

/// The rule (pure over the drive kind, so it is testable anywhere).
pub fn judge_local_path(path: &str, kind: DriveKind) -> LocalPathCheck {
    let trimmed = path.trim();
    let reason = if trimmed.is_empty() {
        Some("No path given".to_string())
    } else if is_unc(trimmed) {
        Some("A network path (UNC) dies with the share it is on; choose a file on a local disk".to_string())
    } else if drive_root(trimmed).is_none() {
        Some("Use an absolute path on a local disk (e.g. D:/fallback/slate.mov)".to_string())
    } else {
        match kind {
            DriveKind::Fixed | DriveKind::Removable => None,
            DriveKind::Network => Some("That drive letter is a mapped network drive; choose a local disk".to_string()),
            DriveKind::Missing => Some("That drive does not exist on this PC".to_string()),
            DriveKind::Other => Some("That drive is not a local disk".to_string()),
        }
    };
    LocalPathCheck { local: reason.is_none(), kind, reason }
}

#[tauri::command]
pub async fn check_local_media_path(path: String) -> Result<LocalPathCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = drive_kind(&path);
        judge_local_path(&path, kind)
    })
    .await
    .map_err(|e| format!("drive check failed: {}", e))
}

fn extension_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn is_video_file(path: &Path) -> bool {
    VIDEO_EXTENSIONS.contains(&extension_of(path).as_str())
}

fn is_still(path: &Path) -> bool {
    STILL_EXTENSIONS.contains(&extension_of(path).as_str())
}

/// The files `FALLBACK LIST` would play: the folder's video files, not
/// recursive, sorted by name (case-insensitive), as contract C2 says.
pub fn list_filler_files(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(folder).map_err(|e| format!("Cannot read '{}': {}", folder.display(), e))?;
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_video_file(path))
        .collect();
    files.sort_by_key(|path| path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default());
    Ok(files)
}

/// The file an engine clip name points at. Absolute names are taken as they
/// are; a media-relative name (`playout/emergency`) is looked up under the
/// media root with or without an extension, as CasparCG does.
pub fn resolve_clip_file(clip: &str, media_root: &str) -> Option<PathBuf> {
    let clip = clip.trim();
    if clip.is_empty() {
        return None;
    }
    let direct = PathBuf::from(clip);
    if drive_root(clip).is_some() || is_unc(clip) {
        return direct.is_file().then_some(direct);
    }
    if media_root.trim().is_empty() {
        return None;
    }
    let candidate = Path::new(media_root.trim()).join(clip);
    if candidate.is_file() {
        return Some(candidate);
    }
    let parent = candidate.parent()?;
    let stem = candidate.file_name()?.to_string_lossy().to_lowercase();
    std::fs::read_dir(parent).ok()?.flatten().map(|e| e.path()).find(|path| {
        path.is_file()
            && path.file_stem().map(|s| s.to_string_lossy().to_lowercase() == stem).unwrap_or(false)
            && (is_video_file(path) || is_still(path))
    })
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ClipTest {
    pub ok: bool,
    pub path: Option<String>,
    pub local: bool,
    pub duration_ms: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FillerTest {
    pub ok: bool,
    pub local: bool,
    pub files: usize,
    /// The first filler that probed OK.
    pub first_ok: Option<String>,
    pub failed: Vec<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FallbackSelfTest {
    pub clip: Option<ClipTest>,
    pub fillers: Option<FillerTest>,
}

/// A probe result is usable when the file decodes and has a duration (a still
/// image has none and is fine as a looped slate).
pub fn probe_usable(path: &Path, probed: &Result<crate::db::CachedMediaEntry, String>) -> Result<i64, String> {
    match probed {
        Ok(entry) if entry.duration_ms > 0 || is_still(path) => Ok(entry.duration_ms),
        Ok(_) => Err("probes with no duration".to_string()),
        Err(e) => Err(e.clone()),
    }
}

async fn test_clip(ffprobe: &str, clip: &str, media_root: &str) -> ClipTest {
    let clip_owned = clip.to_string();
    let root_owned = media_root.to_string();
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let file = resolve_clip_file(&clip_owned, &root_owned);
        let kind = file.as_ref().map(|f| drive_kind(&f.to_string_lossy()));
        (file, kind)
    })
    .await
    .unwrap_or((None, None));
    let (Some(file), kind) = resolved else {
        return ClipTest { reason: Some(format!("'{}' was not found", clip)), ..Default::default() };
    };
    let local = matches!(kind, Some(DriveKind::Fixed) | Some(DriveKind::Removable));
    let path = file.to_string_lossy().into_owned();
    let probed = crate::scanner::probe_media_metadata_async(ffprobe.to_string(), path.clone()).await;
    match probe_usable(&file, &probed) {
        Ok(duration_ms) => ClipTest {
            ok: true,
            path: Some(path),
            local,
            duration_ms,
            reason: (!local).then(|| "the clip is not on a local disk".to_string()),
        },
        Err(e) => ClipTest { ok: false, path: Some(path), local, duration_ms: 0, reason: Some(format!("does not probe: {}", e)) },
    }
}

async fn test_fillers(ffprobe: &str, folder: &str) -> FillerTest {
    let folder_owned = folder.to_string();
    let listed = tauri::async_runtime::spawn_blocking(move || {
        let kind = drive_kind(&folder_owned);
        (judge_local_path(&folder_owned, kind), list_filler_files(Path::new(folder_owned.trim())))
    })
    .await;
    let (check, files) = match listed {
        Ok(pair) => pair,
        Err(e) => return FillerTest { reason: Some(format!("folder check failed: {}", e)), ..Default::default() },
    };
    let files = match files {
        Ok(files) => files,
        Err(e) => return FillerTest { local: check.local, reason: Some(e), ..Default::default() },
    };
    let mut result = FillerTest { local: check.local, files: files.len(), ..Default::default() };
    if !check.local {
        result.reason = check.reason;
        return result;
    }
    if files.is_empty() {
        result.reason = Some("the folder holds no video files".to_string());
        return result;
    }
    // At least one must open; stop at the first that does.
    for file in files {
        let path = file.to_string_lossy().into_owned();
        let probed = crate::scanner::probe_media_metadata_async(ffprobe.to_string(), path.clone()).await;
        match probe_usable(&file, &probed) {
            Ok(_) => {
                result.ok = true;
                result.first_ok = Some(path);
                break;
            }
            Err(_) => result.failed.push(path),
        }
    }
    if !result.ok {
        result.reason = Some("no filler probes OK".to_string());
    }
    result
}

/// AE-2/AE-4 self-test: the fallback clip and the filler folder.
#[tauri::command]
pub async fn fallback_self_test<R: Runtime>(
    app: AppHandle<R>,
    clip: Option<String>,
    media_root: Option<String>,
    filler_folder: Option<String>,
    runtime_settings: State<'_, crate::runtime_settings::RuntimeSettingsState>,
) -> Result<FallbackSelfTest, String> {
    let ffprobe = crate::scanner::get_ffprobe_path(Some(&app), Some(&runtime_settings));
    let clip = clip.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let folder = filler_folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    let root = media_root.unwrap_or_default();
    tokio::time::timeout(SELF_TEST_DEADLINE, async {
        let clip_test = match clip {
            Some(clip) => Some(test_clip(&ffprobe, &clip, &root).await),
            None => None,
        };
        let filler_test = match folder {
            Some(folder) => Some(test_fillers(&ffprobe, &folder).await),
            None => None,
        };
        FallbackSelfTest { clip: clip_test, fillers: filler_test }
    })
    .await
    .map_err(|_| format!("The fallback self-test did not finish within {} s", SELF_TEST_DEADLINE.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("playout-fallback-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unc_and_drive_roots_are_recognised() {
        assert!(is_unc(r"\\TX01\Mezz\a.mov"));
        assert!(is_unc("//TX01/Mezz/a.mov"));
        assert!(is_unc(r"\\?\UNC\TX01\Mezz"));
        assert!(!is_unc(r"\\?\D:\fallback"));
        assert!(!is_unc("D:/fallback/slate.mov"));
        assert_eq!(drive_root("d:/fallback/slate.mov").as_deref(), Some("D:\\"));
        assert_eq!(drive_root(r"\\?\E:\x").as_deref(), Some("E:\\"));
        assert_eq!(drive_root("playout/emergency"), None);
    }

    #[test]
    fn only_local_absolute_paths_pass() {
        assert!(judge_local_path("D:/fallback/slate.mov", DriveKind::Fixed).local);
        assert!(judge_local_path("E:/fallback/slate.mov", DriveKind::Removable).local);
        assert!(!judge_local_path("Z:/fallback/slate.mov", DriveKind::Network).local);
        assert!(!judge_local_path(r"\\TX01\share\slate.mov", DriveKind::Fixed).local);
        assert!(!judge_local_path("Q:/x.mov", DriveKind::Missing).local);
        assert!(!judge_local_path("playout/emergency", DriveKind::Other).local);
        assert!(!judge_local_path("  ", DriveKind::Fixed).local);
    }

    #[cfg(windows)]
    #[test]
    fn the_system_drive_is_local() {
        let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        assert_eq!(drive_kind(&format!("{}/Windows", system)), DriveKind::Fixed);
        assert_eq!(drive_kind(r"\\server\share\x"), DriveKind::Network);
    }

    #[test]
    fn filler_listing_is_non_recursive_video_only_and_sorted() {
        let dir = temp_dir("list");
        for name in ["b.mov", "A.mp4", "c.txt", "d.png", "e.MXF"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("z.mov"), b"x").unwrap();
        let names: Vec<String> = list_filler_files(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["A.mp4", "b.mov", "e.MXF"]);
        assert!(list_filler_files(&dir.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clip_names_resolve_like_casparcg() {
        let dir = temp_dir("clip");
        std::fs::create_dir_all(dir.join("playout")).unwrap();
        std::fs::write(dir.join("playout").join("emergency.png"), b"x").unwrap();
        let root = dir.to_string_lossy().into_owned();
        assert_eq!(
            resolve_clip_file("playout/emergency", &root),
            Some(dir.join("playout").join("emergency.png"))
        );
        assert_eq!(resolve_clip_file("playout/emergency.png", &root), Some(dir.join("playout").join("emergency.png")));
        assert_eq!(resolve_clip_file("playout/nothing", &root), None);
        let absolute = dir.join("playout").join("emergency.png").to_string_lossy().into_owned();
        assert!(resolve_clip_file(&absolute, "").is_some());
        assert_eq!(resolve_clip_file("playout/emergency", ""), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_still_needs_no_duration_but_a_video_does() {
        let entry = |duration_ms| {
            let mut e: crate::db::CachedMediaEntry = serde_json::from_value(serde_json::json!({
                "path": "x", "duration_ms": duration_ms, "trim_in_ms": 0, "trim_out_ms": 0, "width": 0, "height": 0,
                "codec": "", "fps_num": 25, "fps_den": 1, "timecode_start": "", "playoutvue_id": "",
                "display_aspect_ratio": "", "field_order": "", "transcode_profile": "", "transcoded_at": "",
                "original_source_path": ""
            }))
            .unwrap_or_else(|e| panic!("CachedMediaEntry fixture: {}", e));
            e.duration_ms = duration_ms;
            e
        };
        assert!(probe_usable(Path::new("slate.png"), &Ok(entry(0))).is_ok());
        assert!(probe_usable(Path::new("filler.mov"), &Ok(entry(0))).is_err());
        assert_eq!(probe_usable(Path::new("filler.mov"), &Ok(entry(7000))), Ok(7000));
        assert!(probe_usable(Path::new("filler.mov"), &Err("bad".into())).is_err());
    }
}
