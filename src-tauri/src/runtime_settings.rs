use serde::{Deserialize, Serialize};
use parking_lot::Mutex;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub debug_enabled: bool,
    pub ffmpeg_bin_path: String,
    pub ingestor_api_base_url: String,
    /// PlayoutTranscode `server.api_token`. Empty means the service runs
    /// unauthenticated (its default). Sent as `X-Api-Token` on every Ingestor
    /// call; never written to any log.
    #[serde(default)]
    pub ingestor_api_token: String,
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
            ingestor_api_token: String::new(),
            casparcg_executable_path: String::new(),
            casparcg_config_filename: default_casparcg_config_filename(),
            caspar_auto_start: false,
            caspar_keep_alive_on_exit: true,
            caspar_auto_relaunch_on_crash: true,
        }
    }
}

/// `Debug` is implemented by hand so the API token can never leak through a
/// `{:?}` in a log line or a panic message.
impl std::fmt::Debug for RuntimeSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeSettings")
            .field("debug_enabled", &self.debug_enabled)
            .field("ffmpeg_bin_path", &self.ffmpeg_bin_path)
            .field("ingestor_api_base_url", &self.ingestor_api_base_url)
            .field(
                "ingestor_api_token",
                &if self.ingestor_api_token.is_empty() { "<unset>" } else { "<redacted>" },
            )
            .field("casparcg_executable_path", &self.casparcg_executable_path)
            .field("casparcg_config_filename", &self.casparcg_config_filename)
            .field("caspar_auto_start", &self.caspar_auto_start)
            .field("caspar_keep_alive_on_exit", &self.caspar_keep_alive_on_exit)
            .field("caspar_auto_relaunch_on_crash", &self.caspar_auto_relaunch_on_crash)
            .finish()
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
    let mut settings = settings;
    settings.ingestor_api_token = settings.ingestor_api_token.trim().to_string();
    if let Err(error) = save_settings_to_disk(&settings) {
        log::error!("{}", error);
        return Err(error);
    }
    state.update(settings.clone());
    diagnostics.set_enabled(settings.debug_enabled);
    Ok(())
}

pub fn get_ingestor_api_base_url<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<RuntimeSettingsState>()
        .map(|s| s.snapshot().ingestor_api_base_url)
        .unwrap_or_else(|| RuntimeSettings::default().ingestor_api_base_url)
}

/// The configured Ingestor API token, trimmed. Empty when none is set.
pub fn get_ingestor_api_token<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<RuntimeSettingsState>()
        .map(|s| s.snapshot().ingestor_api_token.trim().to_string())
        .unwrap_or_default()
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

fn save_settings_to_disk(settings: &RuntimeSettings) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialise runtime settings: {}", e))?;
    crate::atomic_fs::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("Failed to persist runtime settings to '{}': {}", path.display(), e))
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
