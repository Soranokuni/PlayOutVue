//! Crash-safe file writes shared by every module that persists operator data
//! (rundowns, presets, templates, runtime settings).
//!
//! `write_atomic` writes to a uniquely named temp file next to the target,
//! fsyncs it and renames it over the destination. `rename` replaces atomically
//! on both Windows (`MOVEFILE_REPLACE_EXISTING`) and POSIX, so a crash or power
//! loss mid-write leaves either the previous complete file or the new one --
//! never a truncated JSON/XML document.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string())
}

/// Write `bytes` to `path` atomically (temp file + fsync + rename).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    let sequence = TMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let tmp_path = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        file_name_of(path),
        std::process::id(),
        sequence
    ));

    let result = (|| -> io::Result<()> {
        let mut file = File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

/// Like [`write_atomic`], but first copies an existing destination to
/// `<name>.bak` so an operator can recover the previous version by hand.
/// Returns the backup path when one was made.
pub fn write_atomic_with_backup(path: &Path, bytes: &[u8]) -> io::Result<Option<PathBuf>> {
    let backup = if path.is_file() {
        let backup_path = path.with_file_name(format!("{}.bak", file_name_of(path)));
        fs::copy(path, &backup_path)?;
        Some(backup_path)
    } else {
        None
    };
    write_atomic(path, bytes)?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "playout_atomic_fs_{}_{}_{}",
            tag,
            std::process::id(),
            TMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn write_atomic_creates_parent_and_leaves_no_temp_files() {
        let dir = temp_dir("create");
        let target = dir.join("nested").join("rundown.json");
        write_atomic(&target, b"{\"a\":1}").expect("write");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"a\":1}");

        write_atomic(&target, b"{\"a\":2}").expect("overwrite");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"a\":2}");

        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_with_backup_keeps_previous_version() {
        let dir = temp_dir("backup");
        let target = dir.join("playlist.json");
        assert_eq!(write_atomic_with_backup(&target, b"v1").unwrap(), None);
        let backup = write_atomic_with_backup(&target, b"v2").unwrap().expect("backup made");
        assert_eq!(fs::read_to_string(&target).unwrap(), "v2");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "v1");
        assert!(backup.file_name().unwrap().to_string_lossy().ends_with("playlist.json.bak"));
        let _ = fs::remove_dir_all(&dir);
    }
}
