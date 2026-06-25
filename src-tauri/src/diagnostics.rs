use serde::Serialize;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use std::io::Write as _;

const MAX_DIAGNOSTIC_ENTRIES: usize = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    pub timestamp_ms: u64,
    pub level: String,
    pub scope: String,
    pub message: String,
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
        if !self.is_enabled() {
            return;
        }

        let msg_str = message.into();
        let timestamp = now_ms();
        let entry = DiagnosticEntry {
            timestamp_ms: timestamp,
            level: level.to_string(),
            scope: scope.to_string(),
            message: msg_str.clone(),
        };

        // 1. In-memory circular buffer for frontend diagnostics panel
        {
            let mut entries = self.entries.lock();
            if entries.len() >= MAX_DIAGNOSTIC_ENTRIES {
                entries.pop_front();
            }
            entries.push_back(entry);
        }

        // 2. Real-time file logging to playout.log
        let log_line = format!(
            "{} [{}] {} {}\n",
            format_timestamp(timestamp),
            level.to_uppercase(),
            scope,
            msg_str
        );

        if let Some(mut path) = dirs_next::data_dir() {
            path.push("com.playout.client");
            let _ = std::fs::create_dir_all(&path);
            path.push("playout.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = file.write_all(log_line.as_bytes());
            }
        }
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