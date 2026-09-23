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
    /// Ask Windows to relaunch PlayOut after it crashes or hangs (Restart
    /// Manager), and relaunch it ourselves after a fatal main-thread panic.
    #[serde(default = "default_true")]
    pub playout_auto_restart: bool,

    // --- CG Studio AI designer ------------------------------------------
    /// Provider for the CG Studio AI designer. An enum in all but name so
    /// others can follow; only "anthropic" is implemented.
    #[serde(default = "default_ai_provider")]
    pub ai_provider: String,
    /// API key for the AI designer.
    ///
    /// Held here rather than in cgAdvisoryConfig on purpose: the advisory
    /// template is copied to the CasparCG host and cached by browsers, so a
    /// key baked into it would be readable by anyone who can reach that
    /// machine. The bridge reads it from here and never echoes it back.
    #[serde(default)]
    pub ai_api_key: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    /// Reasoning effort for a restyle. Full asset generation uses one level up.
    #[serde(default = "default_ai_effort")]
    pub ai_effort: String,
    /// Soft monthly spend ceiling in US dollars; 0 means no cap. Advisory: it
    /// is compared against the usage the bridge accumulates, not enforced by
    /// the API.
    #[serde(default)]
    pub ai_monthly_cap_usd: f64,
}

fn default_ai_provider() -> String {
    "anthropic".to_string()
}

fn default_ai_model() -> String {
    "claude-opus-5".to_string()
}

fn default_ai_effort() -> String {
    "medium".to_string()
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
            playout_auto_restart: true,
            ai_provider: default_ai_provider(),
            ai_api_key: String::new(),
            ai_model: default_ai_model(),
            ai_effort: default_ai_effort(),
            ai_monthly_cap_usd: 0.0,
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
            .field("playout_auto_restart", &self.playout_auto_restart)
            .field("ai_provider", &self.ai_provider)
            .field(
                "ai_api_key",
                &if self.ai_api_key.is_empty() { "<unset>" } else { "<redacted>" },
            )
            .field("ai_model", &self.ai_model)
            .field("ai_effort", &self.ai_effort)
            .field("ai_monthly_cap_usd", &self.ai_monthly_cap_usd)
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

/// Order of `apply_runtime_settings` calls, and the newest one written.
static APPLY_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LAST_WRITTEN_SEQUENCE: Mutex<u64> = Mutex::new(0);

/// PERF-PLAN PR F: the settings file is written with an fsync, and the
/// frontend calls this from a deep watch on every settings change. As a sync
/// command that fsync ran on the main thread; it now runs on the blocking
/// pool. Two calls can then be in flight at once, so each carries a sequence
/// number and one that lost the race to a newer call neither writes nor
/// applies: the newest settings win, on disk and in memory, as before.
#[tauri::command]
pub async fn apply_runtime_settings(
    settings: RuntimeSettings,
    state: State<'_, RuntimeSettingsState>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let mut settings = settings;
    settings.ingestor_api_token = settings.ingestor_api_token.trim().to_string();
    settings.ai_api_key = settings.ai_api_key.trim().to_string();

    let sequence = APPLY_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let to_write = settings.clone();
    let written = tauri::async_runtime::spawn_blocking(move || {
        write_in_order(&LAST_WRITTEN_SEQUENCE, sequence, || save_settings_to_disk(&to_write))
    })
        .await
        .map_err(|e| format!("settings save task failed: {}", e))?;
    match written {
        Err(error) => {
            log::error!("{}", error);
            Err(error)
        }
        // Superseded by a newer call, which applies its own settings.
        Ok(false) => Ok(()),
        Ok(true) => {
            state.update(settings.clone());
            diagnostics.set_enabled(settings.debug_enabled);
            crate::recovery::sync_auto_restart(settings.playout_auto_restart);
            Ok(())
        }
    }
}

/// Run `write` unless a newer call already has. `Ok(false)` = superseded.
fn write_in_order(
    last_written: &Mutex<u64>,
    sequence: u64,
    write: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let mut last = last_written.lock();
    if sequence < *last {
        return Ok(false);
    }
    write()?;
    *last = sequence;
    Ok(true)
}

pub fn get_ingestor_api_base_url<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<RuntimeSettingsState>()
        .map(|s| s.snapshot().ingestor_api_base_url)
        .unwrap_or_else(|| RuntimeSettings::default().ingestor_api_base_url)
}

/// The configured AI designer API key, trimmed. Empty when none is set.
///
/// Only `ai_designer` and the bridge's `/api/ai/generate` route call this. It
/// must never reach a log line, a response body, or `cgAdvisoryConfig`.
pub fn get_ai_api_key<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<RuntimeSettingsState>()
        .map(|s| s.snapshot().ai_api_key.trim().to_string())
        .unwrap_or_default()
}

/// The configured AI designer settings, without the key.
pub fn get_ai_config<R: Runtime>(app: &AppHandle<R>) -> (String, String, String, f64) {
    app.try_state::<RuntimeSettingsState>()
        .map(|s| {
            let snap = s.snapshot();
            (snap.ai_provider, snap.ai_model, snap.ai_effort, snap.ai_monthly_cap_usd)
        })
        .unwrap_or_else(|| {
            (default_ai_provider(), default_ai_model(), default_ai_effort(), 0.0)
        })
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

#[cfg(test)]
mod apply_order_tests {
    use super::*;

    #[test]
    fn an_older_apply_that_finishes_late_does_not_overwrite_a_newer_one() {
        let last = Mutex::new(0);
        let mut disk = Vec::new();
        // Call 2 reaches the blocking pool first, call 1 after it.
        assert_eq!(write_in_order(&last, 2, || { disk.push(2); Ok(()) }), Ok(true));
        assert_eq!(write_in_order(&last, 1, || { disk.push(1); Ok(()) }), Ok(false));
        assert_eq!(disk, vec![2]);
    }

    #[test]
    fn a_failed_write_does_not_claim_the_sequence() {
        let last = Mutex::new(0);
        assert!(write_in_order(&last, 2, || Err("disk full".to_string())).is_err());
        // The older call may still write, since nothing newer reached disk.
        assert_eq!(write_in_order(&last, 1, || Ok(())), Ok(true));
        assert_eq!(write_in_order(&last, 3, || Ok(())), Ok(true));
    }
}
