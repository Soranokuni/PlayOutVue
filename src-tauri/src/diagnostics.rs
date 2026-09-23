use serde::Serialize;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::mpsc;
use tokio::io::AsyncWriteExt;
use std::sync::OnceLock;
use std::path::Path;

static LOG_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Bounded so a stalled disk can never grow the in-memory backlog without
/// limit; when full, new lines are dropped (counted) instead of buffered.
const LOG_CHANNEL_CAPACITY: usize = 8192;
/// Rotate `caspar-playout.log` at this size and keep this many old files.
const LOG_ROTATE_BYTES: u64 = 20 * 1024 * 1024;
const LOG_KEEP_ROTATED: usize = 5;
static LOG_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn enqueue_log_line(line: String) {
    if let Some(tx) = LOG_TX.get() {
        if tx.try_send(line).is_err() {
            LOG_DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// Shift `<log>.1` -> `<log>.2` ... and move the live file to `<log>.1`,
/// keeping at most `keep` rotated generations.
pub fn rotate_log_files(path: &Path, keep: usize) {
    let base = path.to_string_lossy().into_owned();
    for index in (1..keep).rev() {
        let from = std::path::PathBuf::from(format!("{}.{}", base, index));
        let to = std::path::PathBuf::from(format!("{}.{}", base, index + 1));
        if from.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    if keep >= 1 && path.exists() {
        let _ = std::fs::rename(path, std::path::PathBuf::from(format!("{}.1", base)));
    }
}
#[allow(dead_code)]
static INSTALL_SALT: OnceLock<String> = OnceLock::new();

#[allow(dead_code)]
pub fn get_or_init_install_salt() -> &'static str {
    INSTALL_SALT.get_or_init(|| {
        if let Some(mut path) = dirs_next::data_dir() {
            path.push("com.playout.client");
            let _ = std::fs::create_dir_all(&path);
            path.push("install.salt");
            if let Ok(salt) = std::fs::read_to_string(&path) {
                if !salt.trim().is_empty() {
                    return salt.trim().to_string();
                }
            }
            let new_salt = format!("{:x}{:x}", now_ms(), std::process::id());
            let _ = std::fs::write(&path, &new_salt);
            return new_salt;
        }
        "default-install-salt".to_string()
    })
}

pub fn redact_path(path_str: &str) -> String {
    let salt = get_or_init_install_salt();
    let filename = Path::new(path_str)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    
    // Hash path_str with salt
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in salt.bytes().chain(path_str.bytes()) {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("[REDACTED:{:016x}:{}]", hash, filename)
}

#[tauri::command]
pub fn redact_path_for_diagnostics(path: String) -> String {
    redact_path(&path)
}

pub fn init_background_logger() {
    let (tx, mut rx) = mpsc::channel::<String>(LOG_CHANNEL_CAPACITY);
    if LOG_TX.set(tx).is_err() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let Some(mut path) = dirs_next::data_dir() else { return };
        path.push("com.playout.client");
        let _ = tokio::fs::create_dir_all(&path).await;
        path.push("caspar-playout.log");

        async fn open_append(path: &Path) -> Option<(tokio::fs::File, u64)> {
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
                .ok()?;
            let written = file.metadata().await.map(|m| m.len()).unwrap_or(0);
            Some((file, written))
        }

        let Some((mut file, mut written)) = open_append(&path).await else { return };

        while let Some(log_line) = rx.recv().await {
            let bytes = log_line.as_bytes();
            if written.saturating_add(bytes.len() as u64) > LOG_ROTATE_BYTES {
                let _ = file.flush().await;
                drop(file);
                rotate_log_files(&path, LOG_KEEP_ROTATED);
                match open_append(&path).await {
                    Some((f, w)) => {
                        file = f;
                        written = w;
                    }
                    None => return,
                }
            }
            if file.write_all(bytes).await.is_ok() {
                written = written.saturating_add(bytes.len() as u64);
            }
            // Flush per line: this log exists for post-mortems, and the tail
            // must survive an abrupt exit.
            let _ = file.flush().await;
        }
    });
}

pub fn push_caspar_process_log(level: &str, msg: &str) {
    let log_line = format!(
        "{} [{}] [CasparServer] {}\n",
        format_timestamp(now_ms()),
        level.to_uppercase(),
        msg
    );
    enqueue_log_line(log_line);
}

const MAX_DIAGNOSTIC_ENTRIES: usize = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    pub timestamp_ms: u64,
    pub level: String,
    pub scope: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub take_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
}

pub struct DiagnosticState {
    enabled: Mutex<bool>,
    entries: Mutex<VecDeque<DiagnosticEntry>>,
}

impl Default for DiagnosticState {
    fn default() -> Self {
        Self {
            enabled: Mutex::new(false),
            entries: Mutex::new(VecDeque::with_capacity(MAX_DIAGNOSTIC_ENTRIES)),
        }
    }
}

impl DiagnosticState {
    pub fn set_enabled(&self, enabled: bool) {
        *self.enabled.lock() = enabled;

        if !enabled {
            self.clear();
        }
    }

    pub fn is_enabled(&self) -> bool {
        *self.enabled.lock()
    }

    pub fn push(&self, level: &str, scope: &str, message: impl Into<String>) {
        let msg_str = message.into();
        let timestamp = now_ms();

        // Write to background log
        let log_line = format!(
            "{} [{}] {} {}\n",
            format_timestamp(timestamp),
            level.to_uppercase(),
            scope,
            msg_str
        );

        enqueue_log_line(log_line);

        if !self.is_enabled() {
            return;
        }

        let entry = DiagnosticEntry {
            timestamp_ms: timestamp,
            level: level.to_string(),
            scope: scope.to_string(),
            message: msg_str,
            take_id: None,
            play_generation: None,
            item_id: None,
        };

        let mut entries = self.entries.lock();
        if entries.len() >= MAX_DIAGNOSTIC_ENTRIES {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    pub fn recent(&self, limit: usize) -> Vec<DiagnosticEntry> {
        let capped_limit = limit.clamp(1, MAX_DIAGNOSTIC_ENTRIES);
        let entries = self.entries.lock();

        let mut result = entries.iter().rev().take(capped_limit).cloned().collect::<Vec<_>>();
        result.reverse();
        result
    }

    pub fn clear(&self) {
        self.entries.lock().clear();
    }
}

#[tauri::command]
pub fn push_diagnostic_log(
    level: String,
    scope: String,
    message: String,
    diagnostics: State<'_, DiagnosticState>,
) {
    diagnostics.push(&level, &scope, message);
}

#[tauri::command]
pub fn get_diagnostic_logs(limit: Option<usize>, diagnostics: State<'_, DiagnosticState>) -> Vec<DiagnosticEntry> {
    diagnostics.recent(limit.unwrap_or(100))
}

#[tauri::command]
pub fn clear_diagnostic_logs(diagnostics: State<'_, DiagnosticState>) {
    diagnostics.clear();
}

/// PERF-PLAN PR F: async, with the file write on the blocking pool (it can be
/// a network path the operator picked).
#[tauri::command]
pub async fn export_diagnostic_logs(output_path: String, diagnostics: State<'_, DiagnosticState>) -> Result<String, String> {
    let entries = diagnostics.recent(MAX_DIAGNOSTIC_ENTRIES);
    let mut content = String::new();

    for entry in entries {
        let _ = writeln!(
            content,
            "{} [{}] {} {}",
            format_timestamp(entry.timestamp_ms),
            entry.level.to_uppercase(),
            entry.scope,
            entry.message
        );
    }

    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&output_path, content)
            .map_err(|error| format!("Failed to export diagnostic logs '{}': {}", output_path, error))?;
        Ok(output_path)
    })
    .await
    .map_err(|e| format!("diagnostic export task failed: {}", e))?
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn format_timestamp(timestamp_ms: u64) -> String {
    format!("{}", timestamp_ms)
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn rotate_log_files_shifts_generations_and_caps_count() {
        let dir = std::env::temp_dir().join(format!("playout_log_rotate_{}_{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("caspar-playout.log");
        for gen in 0..4 {
            std::fs::write(&log, format!("gen{}", gen)).unwrap();
            rotate_log_files(&log, 3);
        }
        assert!(!log.exists(), "live file moved to .1");
        assert_eq!(std::fs::read_to_string(dir.join("caspar-playout.log.1")).unwrap(), "gen3");
        assert_eq!(std::fs::read_to_string(dir.join("caspar-playout.log.2")).unwrap(), "gen2");
        assert_eq!(std::fs::read_to_string(dir.join("caspar-playout.log.3")).unwrap(), "gen1");
        assert!(!dir.join("caspar-playout.log.4").exists(), "gen0 must have been dropped");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn test_redact_path_consistency() {
        let path = "C:\\Media\\Video1.mp4";
        let redacted1 = redact_path(path);
        let redacted2 = redact_path(path);
        assert_eq!(redacted1, redacted2);
        assert!(redacted1.contains("Video1.mp4"));
        assert!(redacted1.contains("[REDACTED:"));
    }
}