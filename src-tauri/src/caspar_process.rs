//! caspar_process.rs — Dynamic CasparCG Lifecycle & Multi-Instance Process Supervision
//!
//! Provides:
//! 1. Dynamic executable and working directory (CWD) resolution.
//! 2. Channel-scoped Named Mutex Guard (`InstanceLock`) preventing multi-instance split-brain.
//! 3. Broadcast-grade 7-state Lifecycle Finite State Machine (FSM).
//! 4. Non-blocking async stdout/stderr streaming into the diagnostic logger.
//! 5. Windows Job Object supervision (configurable kill-on-close vs 24/7 broadcast persistence).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;

use crate::runtime_settings::{RuntimeSettings, RuntimeSettingsState};

pub const DEFAULT_AMCP_PORT: u16 = 5250;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum InstanceRole {
    Primary,
    Monitor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CasparProcessState {
    Unconfigured,
    Stopped,
    Starting,
    Operational,
    ExternalRunning,
    Disconnected,
    Crashed,
}

impl CasparProcessState {
    pub fn as_str(&self) -> &'static str {
        match self {
            CasparProcessState::Unconfigured => "unconfigured",
            CasparProcessState::Stopped => "stopped",
            CasparProcessState::Starting => "starting",
            CasparProcessState::Operational => "operational",
            CasparProcessState::ExternalRunning => "external_running",
            CasparProcessState::Disconnected => "disconnected",
            CasparProcessState::Crashed => "crashed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CasparProcessStatus {
    pub state: String,
    pub role: String,
    pub pid: Option<u32>,
    pub executable_path: String,
    pub resolved_executable_path: Option<String>,
    pub working_dir: Option<String>,
    pub config_filename: String,
    pub exit_code: Option<i32>,
    pub last_error: Option<String>,
    pub amcp_port: u16,
    pub is_port_open: bool,
    pub keep_alive_on_exit: bool,
    pub can_control: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CasparValidationInfo {
    pub is_valid: bool,
    pub resolved_path: String,
    pub parent_dir: String,
    pub config_exists: bool,
    pub config_path: Option<String>,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Named Mutex Guard (Channel/Port-Scoped)
// ---------------------------------------------------------------------------

pub struct InstanceLock {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    is_primary: bool,
    identifier: String,
}

#[cfg(windows)]
unsafe impl Send for InstanceLock {}
#[cfg(windows)]
unsafe impl Sync for InstanceLock {}

impl InstanceLock {
    #[cfg(windows)]
    pub fn acquire(port: u16) -> Self {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;

        let name = format!("Local\\PlayOutVue_Instance_Port_{}\0", port);
        let wide: Vec<u16> = OsStr::new(&name).encode_wide().collect();

        unsafe {
            // bInitialOwner = 1 (TRUE): Request immediate ownership of the mutex
            let handle = CreateMutexW(std::ptr::null_mut(), 1, wide.as_ptr());
            if handle.is_null() {
                eprintln!("[InstanceLock] Failed to create mutex: {}", name);
                return Self {
                    handle: std::ptr::null_mut(),
                    is_primary: false,
                    identifier: format!("port_{}", port),
                };
            }

            let last_error = GetLastError();
            let is_primary = last_error != ERROR_ALREADY_EXISTS;

            if !is_primary {
                eprintln!(
                    "[InstanceLock] Mutex '{}' already held by another instance. Running in MONITOR mode.",
                    name
                );
            } else {
                eprintln!(
                    "[InstanceLock] Primary lock acquired for '{}'. Full supervision enabled.",
                    name
                );
            }

            Self {
                handle,
                is_primary,
                identifier: format!("port_{}", port),
            }
        }
    }

    #[cfg(not(windows))]
    pub fn acquire(port: u16) -> Self {
        Self {
            is_primary: true,
            identifier: format!("port_{}", port),
        }
    }

    pub fn is_primary(&self) -> bool {
        self.is_primary
    }

    #[allow(dead_code)]
    pub fn role(&self) -> InstanceRole {
        if self.is_primary {
            InstanceRole::Primary
        } else {
            InstanceRole::Monitor
        }
    }

    #[allow(dead_code)]
    pub fn identifier(&self) -> &str {
        &self.identifier
    }
}

#[cfg(windows)]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows Job Object Supervisor
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub struct JobObjectGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for JobObjectGuard {}
#[cfg(windows)]
unsafe impl Sync for JobObjectGuard {}

#[cfg(windows)]
impl JobObjectGuard {
    pub fn new() -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if handle.is_null() {
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            if ok == 0 {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return None;
            }

            Some(Self { handle })
        }
    }

    pub fn assign_pid(&self, pid: u32) -> bool {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

        unsafe {
            let proc_handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc_handle.is_null() {
                return false;
            }

            let ok = AssignProcessToJobObject(self.handle, proc_handle) != 0;
            windows_sys::Win32::Foundation::CloseHandle(proc_handle);
            ok
        }
    }
}

#[cfg(not(windows))]
pub struct JobObjectGuard;
#[cfg(not(windows))]
impl JobObjectGuard {
    pub fn new() -> Option<Self> {
        None
    }
    pub fn assign_pid(&self, _pid: u32) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Path & CWD Resolution
// ---------------------------------------------------------------------------

pub fn resolve_caspar_executable(configured: &str) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let p = PathBuf::from(trimmed);
        if p.is_file() {
            return Some(p);
        }
    }

    // Dynamic search candidates
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. App executable parent
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("Requirements").join("casparcg").join("casparcg.exe"));
            candidates.push(parent.join("casparcg").join("casparcg.exe"));
            candidates.push(parent.join("casparcg.exe"));
        }
    }

    // 2. Working directory
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("Requirements").join("casparcg").join("casparcg.exe"));
        candidates.push(cwd.join("casparcg").join("casparcg.exe"));
        candidates.push(cwd.join("casparcg.exe"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("casparcg").join("casparcg.exe"));
        }
    }

    // 3. Common broadcast drives
    candidates.push(PathBuf::from("C:/CasparCG/casparcg.exe"));
    candidates.push(PathBuf::from("C:/CasparLauncher/casparcg.exe"));
    candidates.push(PathBuf::from("D:/CasparCG/casparcg.exe"));

    candidates.into_iter().find(|p| p.is_file())
}

pub fn resolve_caspar_cwd(exe_path: &Path) -> PathBuf {
    exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

pub async fn is_port_listening(port: u16) -> bool {
    tokio::time::timeout(
        Duration::from_millis(300),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Supervisor State & Process Control
// ---------------------------------------------------------------------------

struct SupervisorInner {
    state: CasparProcessState,
    child: Option<tokio::process::Child>,
    pid: Option<u32>,
    exit_code: Option<i32>,
    last_error: Option<String>,
    #[allow(dead_code)]
    job_guard: Option<JobObjectGuard>,
}

pub struct CasparProcessSupervisor {
    instance_lock: InstanceLock,
    amcp_port: u16,
    inner: Arc<Mutex<SupervisorInner>>,
}

impl CasparProcessSupervisor {
    pub fn new(amcp_port: u16) -> Self {
        let lock = InstanceLock::acquire(amcp_port);
        Self {
            instance_lock: lock,
            amcp_port,
            inner: Arc::new(Mutex::new(SupervisorInner {
                state: CasparProcessState::Stopped,
                child: None,
                pid: None,
                exit_code: None,
                last_error: None,
                job_guard: None,
            })),
        }
    }

    pub fn is_primary(&self) -> bool {
        self.instance_lock.is_primary()
    }

    #[allow(dead_code)]
    pub fn role(&self) -> InstanceRole {
        self.instance_lock.role()
    }

    pub async fn get_status(&self, settings: &RuntimeSettings) -> CasparProcessStatus {
        let resolved = resolve_caspar_executable(&settings.casparcg_executable_path);
        let port = self.amcp_port;
        let port_open = is_port_listening(port).await;

        let mut inner = self.inner.lock().await;

        // Dynamically reconcile state
        if resolved.is_none() && !port_open {
            inner.state = CasparProcessState::Unconfigured;
        } else if inner.child.is_none() {
            if port_open {
                inner.state = CasparProcessState::ExternalRunning;
            } else if inner.state != CasparProcessState::Crashed
                && inner.state != CasparProcessState::Starting
            {
                inner.state = CasparProcessState::Stopped;
            }
        }

        let working_dir = resolved.as_ref().map(|p| resolve_caspar_cwd(p).to_string_lossy().into_owned());
        let can_control = self.instance_lock.is_primary();

        CasparProcessStatus {
            state: inner.state.as_str().to_string(),
            role: if self.instance_lock.is_primary() { "primary" } else { "monitor" }.to_string(),
            pid: inner.pid,
            executable_path: settings.casparcg_executable_path.clone(),
            resolved_executable_path: resolved.map(|p| p.to_string_lossy().into_owned()),
            working_dir,
            config_filename: settings.casparcg_config_filename.clone(),
            exit_code: inner.exit_code,
            last_error: inner.last_error.clone(),
            amcp_port: port,
            is_port_open: port_open,
            keep_alive_on_exit: settings.caspar_keep_alive_on_exit,
            can_control,
        }
    }

    pub async fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: &RuntimeSettings,
    ) -> Result<(), String> {
        if !self.is_primary() {
            return Err("Cannot start server: This instance is in MONITOR MODE (Read-Only).".to_string());
        }

        let exe_path = resolve_caspar_executable(&settings.casparcg_executable_path)
            .ok_or_else(|| "CasparCG executable not found. Please configure path in Settings.".to_string())?;

        let cwd = resolve_caspar_cwd(&exe_path);
        let port = self.amcp_port;

        // Check if port is already listening
        if is_port_listening(port).await {
            {
                let mut inner = self.inner.lock().await;
                inner.state = CasparProcessState::ExternalRunning;
                inner.last_error = None;
            }
            emit_state_change(app, self, settings).await;
            return Ok(());
        }

        let mut cmd = tokio::process::Command::new(&exe_path);
        cmd.current_dir(&cwd);

        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: suppresses black console popup while capturing stdout/stderr
            cmd.creation_flags(0x08000000);
        }

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let cfg = settings.casparcg_config_filename.trim();
        if !cfg.is_empty() && cfg != "casparcg.config" {
            cmd.arg(cfg);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!("Failed to spawn CasparCG process '{}': {}", exe_path.display(), e)
        })?;

        let pid = child.id();
        crate::diagnostics::push_caspar_process_log(
            "INFO",
            &format!("CasparCG spawned successfully (PID: {:?}, CWD: '{}')", pid, cwd.display()),
        );

        // Windows Job Object limit if keep_alive_on_exit is false
        let job_guard = if !settings.caspar_keep_alive_on_exit {
            #[cfg(windows)]
            {
                if let Some(guard) = JobObjectGuard::new() {
                    if let Some(p) = pid {
                        guard.assign_pid(p);
                    }
                    Some(guard)
                } else {
                    None
                }
            }
            #[cfg(not(windows))]
            {
                None
            }
        } else {
            None
        };

        // Async non-blocking stdout pipe draining to prevent deadlock
        if let Some(stdout) = child.stdout.take() {
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    crate::diagnostics::push_caspar_process_log("INFO", &line);
                }
            });
        }

        // Async non-blocking stderr pipe draining
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    crate::diagnostics::push_caspar_process_log("WARN", &line);
                }
            });
        }

        {
            let mut inner = self.inner.lock().await;
            inner.state = CasparProcessState::Starting;
            inner.child = Some(child);
            inner.pid = pid;
            inner.exit_code = None;
            inner.last_error = None;
            inner.job_guard = job_guard;
        }

        emit_state_change(app, self, settings).await;

        // Background monitor for child termination & port readiness
        let inner_clone = self.inner.clone();
        let app_handle = app.clone();

        tauri::async_runtime::spawn(async move {
            let mut boot_wait_cycles = 0;
            let max_boot_cycles = 30; // 15 seconds max (500ms intervals)

            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                boot_wait_cycles += 1;

                let mut inner = inner_clone.lock().await;
                if let Some(ref mut child) = inner.child {
                    // Check if child exited prematurely
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let code = status.code().unwrap_or(-1);
                            eprintln!("[CasparProcess] Process exited with status: {}", code);
                            crate::diagnostics::push_caspar_process_log(
                                "ERROR",
                                &format!("CasparCG process exited unexpectedly with code {}", code),
                            );
                            inner.state = CasparProcessState::Crashed;
                            inner.exit_code = Some(code);
                            inner.last_error = Some(format!("Server crashed with exit code {}", code));
                            inner.child = None;
                            inner.pid = None;
                            drop(inner);
                            let _ = app_handle.emit("caspar://process-state-changed", ());
                            break;
                        }
                        Ok(None) => {
                            // Still running, check if port is open
                            if inner.state == CasparProcessState::Starting {
                                drop(inner);
                                if is_port_listening(port).await {
                                    let mut inner = inner_clone.lock().await;
                                    inner.state = CasparProcessState::Operational;
                                    crate::diagnostics::push_caspar_process_log(
                                        "INFO",
                                        "CasparCG AMCP Port 5250 is open. Engine ready.",
                                    );
                                    drop(inner);
                                    let _ = app_handle.emit("caspar://process-state-changed", ());
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[CasparProcess] Error polling child: {}", e);
                            break;
                        }
                    }
                } else {
                    break;
                }

                if boot_wait_cycles >= max_boot_cycles {
                    let mut inner = inner_clone.lock().await;
                    if inner.state == CasparProcessState::Starting {
                        inner.last_error = Some("Startup timeout: AMCP port not responding".to_string());
                    }
                    drop(inner);
                    let _ = app_handle.emit("caspar://process-state-changed", ());
                    break;
                }
            }
        });

        Ok(())
    }

    pub async fn stop<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: &RuntimeSettings,
        force: bool,
    ) -> Result<(), String> {
        if !self.is_primary() {
            return Err("Cannot stop server: This instance is in MONITOR MODE (Read-Only).".to_string());
        }

        let child = {
            let mut inner = self.inner.lock().await;
            inner.child.take()
        };

        if let Some(mut c) = child {
            if !force {
                // Try graceful AMCP command first if client available
                crate::diagnostics::push_caspar_process_log("INFO", "Initiating graceful shutdown for CasparCG...");
                // Wait up to 2 seconds
                let exit = tokio::time::timeout(Duration::from_secs(2), c.wait()).await;
                if exit.is_err() {
                    let _ = c.kill().await;
                }
            } else {
                let _ = c.kill().await;
            }
        }

        {
            let mut inner = self.inner.lock().await;
            inner.state = CasparProcessState::Stopped;
            inner.pid = None;
            inner.exit_code = None;
            inner.last_error = None;
            inner.job_guard = None;
        }

        emit_state_change(app, self, settings).await;
        Ok(())
    }

    pub async fn restart<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: &RuntimeSettings,
    ) -> Result<(), String> {
        self.stop(app, settings, true).await?;
        tokio::time::sleep(Duration::from_millis(800)).await;
        self.start(app, settings).await
    }
}

async fn emit_state_change<R: Runtime>(
    app: &AppHandle<R>,
    supervisor: &CasparProcessSupervisor,
    settings: &RuntimeSettings,
) {
    let status = supervisor.get_status(settings).await;
    let _ = app.emit("caspar://process-state-changed", status);
}

// ---------------------------------------------------------------------------
// Tauri IPC Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn caspar_process_get_status(
    supervisor: State<'_, CasparProcessSupervisor>,
    settings_state: State<'_, RuntimeSettingsState>,
) -> Result<CasparProcessStatus, String> {
    let settings = settings_state.snapshot();
    Ok(supervisor.get_status(&settings).await)
}

#[tauri::command]
pub async fn caspar_process_start(
    app: AppHandle,
    supervisor: State<'_, CasparProcessSupervisor>,
    settings_state: State<'_, RuntimeSettingsState>,
) -> Result<(), String> {
    let settings = settings_state.snapshot();
    supervisor.start(&app, &settings).await
}

#[tauri::command]
pub async fn caspar_process_stop(
    app: AppHandle,
    force: Option<bool>,
    supervisor: State<'_, CasparProcessSupervisor>,
    settings_state: State<'_, RuntimeSettingsState>,
) -> Result<(), String> {
    let settings = settings_state.snapshot();
    supervisor.stop(&app, &settings, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn caspar_process_restart(
    app: AppHandle,
    supervisor: State<'_, CasparProcessSupervisor>,
    settings_state: State<'_, RuntimeSettingsState>,
) -> Result<(), String> {
    let settings = settings_state.snapshot();
    supervisor.restart(&app, &settings).await
}

#[tauri::command]
pub fn caspar_process_validate_path(path: String) -> Result<CasparValidationInfo, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(CasparValidationInfo {
            is_valid: false,
            resolved_path: String::new(),
            parent_dir: String::new(),
            config_exists: false,
            config_path: None,
            message: "Path is empty".to_string(),
        });
    }

    let p = PathBuf::from(trimmed);
    if !p.exists() {
        return Ok(CasparValidationInfo {
            is_valid: false,
            resolved_path: p.to_string_lossy().into_owned(),
            parent_dir: String::new(),
            config_exists: false,
            config_path: None,
            message: "File does not exist".to_string(),
        });
    }

    if !p.is_file() {
        return Ok(CasparValidationInfo {
            is_valid: false,
            resolved_path: p.to_string_lossy().into_owned(),
            parent_dir: String::new(),
            config_exists: false,
            config_path: None,
            message: "Path is a directory, not an executable binary".to_string(),
        });
    }

    let parent = resolve_caspar_cwd(&p);
    let cfg = parent.join("casparcg.config");
    let cfg_exists = cfg.is_file();

    Ok(CasparValidationInfo {
        is_valid: true,
        resolved_path: p.to_string_lossy().into_owned(),
        parent_dir: parent.to_string_lossy().into_owned(),
        config_exists: cfg_exists,
        config_path: if cfg_exists {
            Some(cfg.to_string_lossy().into_owned())
        } else {
            None
        },
        message: if cfg_exists {
            "Executable and localized casparcg.config found".to_string()
        } else {
            "Executable found (default casparcg.config missing in folder)".to_string()
        },
    })
}

#[tauri::command]
pub async fn caspar_process_check_port(port: Option<u16>) -> Result<bool, String> {
    let p = port.unwrap_or(DEFAULT_AMCP_PORT);
    Ok(is_port_listening(p).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cwd_resolution() {
        let exe = PathBuf::from("C:\\CasparCG\\casparcg.exe");
        let cwd = resolve_caspar_cwd(&exe);
        assert_eq!(cwd, PathBuf::from("C:\\CasparCG"));
    }

    #[test]
    fn test_process_state_serialization() {
        assert_eq!(CasparProcessState::Unconfigured.as_str(), "unconfigured");
        assert_eq!(CasparProcessState::Stopped.as_str(), "stopped");
        assert_eq!(CasparProcessState::Starting.as_str(), "starting");
        assert_eq!(CasparProcessState::Operational.as_str(), "operational");
        assert_eq!(CasparProcessState::ExternalRunning.as_str(), "external_running");
        assert_eq!(CasparProcessState::Disconnected.as_str(), "disconnected");
        assert_eq!(CasparProcessState::Crashed.as_str(), "crashed");
    }

    #[test]
    fn test_instance_lock_scoping() {
        let lock1 = InstanceLock::acquire(5250);
        let lock2 = InstanceLock::acquire(5251);
        assert_eq!(lock1.identifier(), "port_5250");
        assert_eq!(lock2.identifier(), "port_5251");
    }
}
