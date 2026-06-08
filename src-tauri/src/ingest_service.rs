use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct IngestServiceState(Mutex<Option<IngestServiceProcess>>);

impl Default for IngestServiceState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

struct IngestServiceProcess {
    child: Child,
    executable: String,
    port: u16,
    destination_path: String,
    watch_folder_path: Option<String>,
    auto_trim_black: bool,
    max_concurrency: usize,
    ffmpeg_threads: usize,
    poll_secs: u64,
    settle_secs: u64,
    include_extensions: String,
    exclude_extensions: String,
    duplicate_policy: String,
    started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestServiceStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub executable: String,
    pub api_base_url: String,
    pub port: u16,
    pub destination_path: String,
    pub watch_folder_path: Option<String>,
    pub auto_trim_black: bool,
    pub max_concurrency: usize,
    pub ffmpeg_threads: usize,
    pub poll_secs: u64,
    pub settle_secs: u64,
    pub include_extensions: String,
    pub exclude_extensions: String,
    pub duplicate_policy: String,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartIngestServiceOptions {
    pub port: u16,
    pub destination_path: String,
    pub watch_folder_path: Option<String>,
    pub auto_trim_black: bool,
    pub max_concurrency: usize,
    pub ffmpeg_threads: usize,
    pub poll_secs: u64,
    pub settle_secs: u64,
    pub include_extensions: Option<String>,
    pub exclude_extensions: Option<String>,
    pub duplicate_policy: Option<String>,
}

#[tauri::command]
pub fn start_ingestd_service<R: Runtime>(
    app: AppHandle<R>,
    options: StartIngestServiceOptions,
    state: State<'_, IngestServiceState>,
) -> Result<IngestServiceStatus, String> {
    let destination = PathBuf::from(options.destination_path.trim());
    if options.destination_path.trim().is_empty() {
        return Err("Destination path is required".to_string());
    }

    std::fs::create_dir_all(&destination)
        .map_err(|error| format!("Failed to create destination path: {}", error))?;

    let watch_folder_path = if let Some(raw) = options.watch_folder_path.clone() {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            let watch_path = PathBuf::from(&trimmed);
            if !watch_path.is_dir() {
                return Err(format!("Watch folder does not exist: {}", watch_path.display()));
            }
            Some(trimmed)
        }
    } else {
        None
    };

    let mut guard = state.0.lock();
    refresh_process_slot(&mut guard);

    if let Some(process) = guard.as_ref() {
        return Ok(status_from_process(process));
    }

    let executable = resolve_ingestd_executable(&app)
        .ok_or_else(|| "Unable to locate playout-ingestd executable".to_string())?;

    let bounded_port = if options.port == 0 { 8088 } else { options.port };
    let bounded_max_concurrency = options.max_concurrency.max(1);
    let bounded_ffmpeg_threads = options.ffmpeg_threads.max(1);
    let bounded_poll_secs = options.poll_secs.max(1);
    let bounded_settle_secs = options.settle_secs.max(1);
    let include_extensions = options
        .include_extensions
        .unwrap_or_default()
        .trim()
        .to_string();
    let exclude_extensions = options
        .exclude_extensions
        .unwrap_or_default()
        .trim()
        .to_string();
    let duplicate_policy = options
        .duplicate_policy
        .unwrap_or_else(|| "skip".to_string())
        .trim()
        .to_ascii_lowercase();

    let mut command = Command::new(&executable);
    command
        .arg("serve")
        .arg("--port")
        .arg(bounded_port.to_string())
        .arg("--dest")
        .arg(destination.to_string_lossy().to_string())
        .arg("--max-concurrency")
        .arg(bounded_max_concurrency.to_string())
        .arg("--ffmpeg-threads")
        .arg(bounded_ffmpeg_threads.to_string())
        .arg("--poll-secs")
        .arg(bounded_poll_secs.to_string())
        .arg("--settle-secs")
        .arg(bounded_settle_secs.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if !include_extensions.is_empty() {
        command.arg("--include-ext").arg(&include_extensions);
    }

    if !exclude_extensions.is_empty() {
        command.arg("--exclude-ext").arg(&exclude_extensions);
    }

    command.arg("--duplicate-policy").arg(&duplicate_policy);

    if options.auto_trim_black {
        command.arg("--auto-trim-black");
    }

    if let Some(watch_path) = &watch_folder_path {
        command.arg("--watch-folder").arg(watch_path);
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start playout-ingestd: {}", error))?;

    let process = IngestServiceProcess {
        child,
        executable: executable.to_string_lossy().to_string(),
        port: bounded_port,
        destination_path: destination.to_string_lossy().to_string(),
        watch_folder_path,
        auto_trim_black: options.auto_trim_black,
        max_concurrency: bounded_max_concurrency,
        ffmpeg_threads: bounded_ffmpeg_threads,
        poll_secs: bounded_poll_secs,
        settle_secs: bounded_settle_secs,
        include_extensions,
        exclude_extensions,
        duplicate_policy,
        started_at_ms: now_ms(),
    };

    let status = status_from_process(&process);
    *guard = Some(process);
    Ok(status)
}

#[tauri::command]
pub fn stop_ingestd_service(state: State<'_, IngestServiceState>) -> Result<IngestServiceStatus, String> {
    stop_ingestd_process(&state);

    Ok(IngestServiceStatus {
        running: false,
        pid: None,
        executable: String::new(),
        api_base_url: String::new(),
        port: 0,
        destination_path: String::new(),
        watch_folder_path: None,
        auto_trim_black: false,
        max_concurrency: 0,
        ffmpeg_threads: 0,
        poll_secs: 0,
        settle_secs: 0,
        include_extensions: String::new(),
        exclude_extensions: String::new(),
        duplicate_policy: String::new(),
        started_at_ms: 0,
    })
}

pub fn stop_ingestd_process(state: &IngestServiceState) {
    let mut guard = state.0.lock();
    refresh_process_slot(&mut guard);

    if let Some(mut process) = guard.take() {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
}

#[tauri::command]
pub fn get_ingestd_service_status(state: State<'_, IngestServiceState>) -> IngestServiceStatus {
    let mut guard = state.0.lock();
    refresh_process_slot(&mut guard);

    if let Some(process) = guard.as_ref() {
        status_from_process(process)
    } else {
        IngestServiceStatus {
            running: false,
            pid: None,
            executable: String::new(),
            api_base_url: String::new(),
            port: 0,
            destination_path: String::new(),
            watch_folder_path: None,
            auto_trim_black: false,
            max_concurrency: 0,
            ffmpeg_threads: 0,
            poll_secs: 0,
            settle_secs: 0,
            include_extensions: String::new(),
            exclude_extensions: String::new(),
            duplicate_policy: String::new(),
            started_at_ms: 0,
        }
    }
}

#[tauri::command]
pub fn ingest_shell_minimize_to_tray(window: WebviewWindow) -> Result<(), String> {
    window
        .minimize()
        .map_err(|error| format!("Failed to minimize window: {}", error))
}

#[tauri::command]
pub fn ingest_shell_exit_app<R: Runtime>(app: AppHandle<R>, state: State<'_, IngestServiceState>) {
    stop_ingestd_process(&state);
    app.exit(0);
}

fn refresh_process_slot(slot: &mut Option<IngestServiceProcess>) {
    let should_clear = slot
        .as_mut()
        .and_then(|process| process.child.try_wait().ok())
        .flatten()
        .is_some();

    if should_clear {
        *slot = None;
    }
}

fn status_from_process(process: &IngestServiceProcess) -> IngestServiceStatus {
    IngestServiceStatus {
        running: true,
        pid: Some(process.child.id()),
        executable: process.executable.clone(),
        api_base_url: format!("http://127.0.0.1:{}", process.port),
        port: process.port,
        destination_path: process.destination_path.clone(),
        watch_folder_path: process.watch_folder_path.clone(),
        auto_trim_black: process.auto_trim_black,
        max_concurrency: process.max_concurrency,
        ffmpeg_threads: process.ffmpeg_threads,
        poll_secs: process.poll_secs,
        settle_secs: process.settle_secs,
        include_extensions: process.include_extensions.clone(),
        exclude_extensions: process.exclude_extensions.clone(),
        duplicate_policy: process.duplicate_policy.clone(),
        started_at_ms: process.started_at_ms,
    }
}

fn resolve_ingestd_executable<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let executable_name = executable_name("playout-ingestd");

    if let Ok(dir) = app.path().executable_dir() {
        candidates.push(dir.join(&executable_name));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(&executable_name));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("target").join("debug").join(&executable_name));
        candidates.push(cwd.join("target").join("debug").join(&executable_name));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .or_else(|| Some(PathBuf::from(executable_name)))
}

fn executable_name(base: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{}.exe", base)
    }

    #[cfg(not(target_os = "windows"))]
    {
        base.to_string()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
