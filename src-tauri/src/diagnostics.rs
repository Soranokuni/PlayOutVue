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

static LOG_TX: OnceLock<mpsc::UnboundedSender<String>> = OnceLock::new();
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
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    if LOG_TX.set(tx).is_err() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Some(mut path) = dirs_next::data_dir() {
            path.push("com.playout.client");
            let _ = tokio::fs::create_dir_all(&path).await;
            path.push("caspar-playout.log");
            
            if let Ok(mut file) = tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .await 
            {
                while let Some(log_line) = rx.recv().await {
                    let _ = file.write_all(log_line.as_bytes()).await;
                }
            }
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
    if let Some(tx) = LOG_TX.get() {
        let _ = tx.send(log_line);
    }
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

        if let Some(tx) = LOG_TX.get() {
            let _ = tx.send(log_line);
        }

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

#[tauri::command]
pub fn export_diagnostic_logs(output_path: String, diagnostics: State<'_, DiagnosticState>) -> Result<String, String> {
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

    std::fs::write(&output_path, content)
        .map_err(|error| format!("Failed to export diagnostic logs '{}': {}", output_path, error))?;

    Ok(output_path)
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
    fn test_redact_path_consistency() {
        let path = "C:\\Media\\Video1.mp4";
        let redacted1 = redact_path(path);
        let redacted2 = redact_path(path);
        assert_eq!(redacted1, redacted2);
        assert!(redacted1.contains("Video1.mp4"));
        assert!(redacted1.contains("[REDACTED:"));
    }
}