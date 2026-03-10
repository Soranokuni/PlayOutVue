use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::diagnostics::DiagnosticState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub debug_enabled: bool,
    pub ffmpeg_bin_path: String,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            debug_enabled: false,
            ffmpeg_bin_path: String::new(),
        }
    }
}

pub struct RuntimeSettingsState(pub Mutex<RuntimeSettings>);

impl Default for RuntimeSettingsState {
    fn default() -> Self {
        Self(Mutex::new(RuntimeSettings::default()))
    }
}

impl RuntimeSettingsState {
    pub fn snapshot(&self) -> RuntimeSettings {
        self.0.lock().map(|settings| settings.clone()).unwrap_or_default()
    }

    pub fn update(&self, next: RuntimeSettings) -> RuntimeSettings {
        if let Ok(mut settings) = self.0.lock() {
            *settings = next.clone();
            return settings.clone();
        }

        next
    }
}

#[tauri::command]
pub fn apply_runtime_settings(
    settings: RuntimeSettings,
    state: State<'_, RuntimeSettingsState>,
    diagnostics: State<'_, DiagnosticState>,
) -> RuntimeSettings {
    diagnostics.set_enabled(settings.debug_enabled);
    let snapshot = state.update(settings.clone());
    if snapshot.debug_enabled {
        diagnostics.push(
            "info",
            "runtime-settings",
            format!(
                "Debug tools enabled. ffmpeg bin override: {}",
                if snapshot.ffmpeg_bin_path.trim().is_empty() {
                    "default Requirements/ffmpeg/bin".to_string()
                } else {
                    snapshot.ffmpeg_bin_path.clone()
                }
            ),
        );
    }
    snapshot
}

pub fn resolve_tool_path<R: Runtime>(app: Option<&AppHandle<R>>, state: Option<&RuntimeSettingsState>, name: &str) -> String {
    let configured_bin = state
        .map(|runtime| runtime.snapshot().ffmpeg_bin_path)
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut candidates: Vec<PathBuf> = Vec::new();

    if !configured_bin.is_empty() {
        candidates.push(PathBuf::from(&configured_bin).join(name));
    }

    if let Some(app) = app {
        if let Ok(dir) = app.path().executable_dir() {
            candidates.push(dir.join("Requirements").join("ffmpeg").join("bin").join(name));
            candidates.push(dir.join("ffmpeg").join("bin").join(name));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("Requirements").join("ffmpeg").join("bin").join(name));
            candidates.push(dir.join("ffmpeg").join("bin").join(name));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("Requirements").join("ffmpeg").join("bin").join(name));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("Requirements").join("ffmpeg").join("bin").join(name));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.trim_end_matches(".exe").to_string())
}