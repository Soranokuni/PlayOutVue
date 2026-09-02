use serde::{Deserialize, Serialize};
use parking_lot::Mutex;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub debug_enabled: bool,
    pub ffmpeg_bin_path: String,
    pub ingestor_api_base_url: String,
    #[serde(default)]
    pub casparcg_executable_path: String,
    #[serde(default = "default_casparcg_config_filename")]
    pub casparcg_config_filename: String,
    #[serde(default)]
    pub caspar_auto_start: bool,
    #[serde(default = "default_true")]
    pub caspar_keep_alive_on_exit: bool,
    #[serde(default = "default_true")]
    pub caspar_auto_relaunch_on_crash: bool,
}

fn default_casparcg_config_filename() -> String {
    "casparcg.config".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            debug_enabled: false,
            ffmpeg_bin_path: String::new(),
            ingestor_api_base_url: "http://127.0.0.1:4353".to_string(),
            casparcg_executable_path: String::new(),
            casparcg_config_filename: default_casparcg_config_filename(),
            caspar_auto_start: false,
            caspar_keep_alive_on_exit: true,
            caspar_auto_relaunch_on_crash: true,
        }
    }
}

pub struct RuntimeSettingsState(pub Mutex<RuntimeSettings>);

impl Default for RuntimeSettingsState {
    fn default() -> Self {
        let mut settings = RuntimeSettings::default();
        if let Some(loaded) = load_settings_from_disk() {
            settings = loaded;
        }
        Self(Mutex::new(settings))
    }
}

impl RuntimeSettingsState {
    pub fn snapshot(&self) -> RuntimeSettings {
        self.0.lock().clone()
    }

pub fn update(&self, next: RuntimeSettings) -> RuntimeSettings {
        let mut settings = self.0.lock();
        *settings = next.clone();
        settings.clone()
    }
}

#[tauri::command]
pub fn apply_runtime_settings(
    settings: RuntimeSettings,
    state: State<'_, RuntimeSettingsState>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    save_settings_to_disk(&settings);
    state.update(settings.clone());
    diagnostics.set_enabled(settings.debug_enabled);
    Ok(())
}

pub fn get_ingestor_api_base_url<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<RuntimeSettingsState>()
        .map(|s| s.snapshot().ingestor_api_base_url)
        .unwrap_or_else(|| RuntimeSettings::default().ingestor_api_base_url)
}

fn config_path() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.playout.client")
        .join("runtime_config.json")
}

fn load_settings_from_disk() -> Option<RuntimeSettings> {
    let path = config_path();
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<RuntimeSettings>(&content).ok()
}

fn save_settings_to_disk(settings: &RuntimeSettings) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let json = serde_json::to_string_pretty(settings).unwrap_or_default();
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::write(&tmp, &json);
    let _ = std::fs::rename(&tmp, &path);
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
