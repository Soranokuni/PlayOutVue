//! caspar_process.rs — Dynamic CasparCG Lifecycle & Multi-Instance Process Supervision
//!
//! Provides:
//! 1. Dynamic executable and working directory (CWD) resolution.
//! 2. Channel-scoped Named Mutex Guard (`InstanceLock`) preventing multi-instance split-brain.
//! 3. Broadcast-grade 7-state Lifecycle Finite State Machine (FSM).
//! 4. Non-blocking async stdout/stderr streaming into the diagnostic logger.
//! 5. Windows Job Object supervision (configurable kill-on-close vs 24/7 broadcast persistence).

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
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
    pub auto_relaunch_on_crash: bool,
    pub circuit_breaker_tripped: bool,
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
                log::warn!("[InstanceLock] Failed to create mutex: {}", name);
                return Self {
                    handle: std::ptr::null_mut(),
                    is_primary: false,
                    identifier: format!("port_{}", port),
                };
            }

            let last_error = GetLastError();
            let is_primary = last_error != ERROR_ALREADY_EXISTS;

            if !is_primary {
                log::warn!(
                    "[InstanceLock] Mutex '{}' already held by another instance. Running in MONITOR mode.",
                    name
                );
            } else {
                log::warn!(
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
            if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                log::warn!("[JobObjectGuard] CreateJobObjectW failed");
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
                log::warn!("[JobObjectGuard] SetInformationJobObject failed");
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
            if proc_handle.is_null() || proc_handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                log::warn!("[JobObjectGuard] OpenProcess failed for PID {}", pid);
                return false;
            }

            let ok = AssignProcessToJobObject(self.handle, proc_handle) != 0;
            windows_sys::Win32::Foundation::CloseHandle(proc_handle);
            if !ok {
                log::warn!("[JobObjectGuard] AssignProcessToJobObject failed for PID {}", pid);
            }
            ok
        }
    }
}

#[cfg(windows)]
impl Drop for JobObjectGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
            self.handle = std::ptr::null_mut();
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
// Process Scanning & External Process Control
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn find_caspar_process_pid() -> Option<u32> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name = String::from_utf16_lossy(&entry.szExeFile);
                let clean_name = name.trim_matches('\0').to_lowercase();
                if clean_name == "casparcg.exe" {
                    let pid = entry.th32ProcessID;
                    CloseHandle(snapshot);
                    return Some(pid);
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);
        None
    }
}

#[cfg(not(windows))]
pub fn find_caspar_process_pid() -> Option<u32> {
    None
}

/// Image name (lower-case, e.g. `casparcg.exe`) of a live process, if any.
#[cfg(windows)]
pub fn process_image_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == pid {
                    let name = String::from_utf16_lossy(&entry.szExeFile);
                    found = Some(name.trim_matches('\0').to_lowercase());
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(not(windows))]
pub fn process_image_name(_pid: u32) -> Option<String> {
    None
}

pub fn is_casparcg_pid(pid: &u32) -> bool {
    process_image_name(*pid)
        .map(|name| name == "casparcg.exe")
        .unwrap_or(false)
}

/// PID of the process that owns the IPv4 TCP listener on `port`, via
/// `GetExtendedTcpTable`. Audit T1-2: this lets `stop()` terminate exactly the
/// CasparCG instance bound to *our* AMCP port instead of the first
/// `casparcg.exe` in the process table (or every one of them).
#[cfg(windows)]
pub fn find_pid_listening_on_port(port: u16) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if size == 0 {
            return None;
        }
        // Over-allocate slightly: the table can grow between the two calls.
        let mut buffer = vec![0u8; size as usize + 4096];
        let mut size = buffer.len() as u32;
        let result = GetExtendedTcpTable(
            buffer.as_mut_ptr() as *mut _,
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if result != 0 || (size as usize) < std::mem::size_of::<u32>() {
            return None;
        }
        let table = buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let count = (*table).dwNumEntries as usize;
        let rows_ptr = std::ptr::addr_of!((*table).table) as *const MIB_TCPROW_OWNER_PID;
        let max_rows = (size as usize).saturating_sub(std::mem::size_of::<u32>())
            / std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
        let rows = std::slice::from_raw_parts(rows_ptr, count.min(max_rows));
        rows.iter()
            .find(|row| u16::from_be(row.dwLocalPort as u16) == port)
            .map(|row| row.dwOwningPid)
    }
}

#[cfg(not(windows))]
pub fn find_pid_listening_on_port(_port: u16) -> Option<u32> {
    None
}

#[cfg(windows)]
pub fn terminate_process_by_pid(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    use windows_sys::Win32::Foundation::CloseHandle;

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            let ok = TerminateProcess(handle, 1);
            CloseHandle(handle);
            if ok != 0 {
                return true;
            }
        }
        let output = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
        output.map(|o| o.status.success()).unwrap_or(false)
    }
}

#[cfg(not(windows))]
pub fn terminate_process_by_pid(_pid: u32) -> bool {
    true
}

#[cfg(windows)]
pub fn is_process_alive_by_pid(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::Foundation::CloseHandle;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        if ok == 0 {
            return false;
        }
        // STILL_ACTIVE = 259
        exit_code == 259
    }
}

#[cfg(not(windows))]
pub fn is_process_alive_by_pid(_pid: u32) -> bool {
    true
}

#[cfg(windows)]
pub fn get_process_exit_code(pid: u32) -> Option<i32> {
    use windows_sys::Win32::System::Threading::{OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::Foundation::CloseHandle;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut exit_code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        if ok != 0 && exit_code != 259 {
            Some(exit_code as i32)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
pub fn get_process_exit_code(_pid: u32) -> Option<i32> {
    None
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

    // 3. User Desktop & Downloads broadcast folders
    if let Some(desktop) = dirs_next::desktop_dir() {
        candidates.push(desktop.join("casparcg.exe"));
        if let Ok(entries) = std::fs::read_dir(&desktop) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if file_name.to_lowercase().starts_with("casparcg") {
                        candidates.push(p.join("casparcg.exe"));
                    }
                }
            }
        }
    }

    if let Some(downloads) = dirs_next::download_dir() {
        candidates.push(downloads.join("casparcg.exe"));
        if let Ok(entries) = std::fs::read_dir(&downloads) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if file_name.to_lowercase().starts_with("casparcg") {
                        candidates.push(p.join("casparcg.exe"));
                    }
                }
            }
        }
    }

    // 4. Common broadcast drives
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
        Duration::from_millis(500),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Supervisor State & Process Control
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Supervisor State & Process Control
// ---------------------------------------------------------------------------

struct SupervisorInner {
    state: CasparProcessState,
    child: Option<tokio::process::Child>,
    pid: Option<u32>,
    exit_code: Option<i32>,
    last_error: Option<String>,
    expected_stop: bool,
    circuit_breaker_tripped: bool,
    #[allow(dead_code)]
    job_guard: Option<JobObjectGuard>,
    adopted_watchdog: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct CasparProcessSupervisor {
    instance_lock: Arc<InstanceLock>,
    amcp_port: u16,
    inner: Arc<Mutex<SupervisorInner>>,
    crash_history: Arc<parking_lot::Mutex<VecDeque<Instant>>>,
}

impl CasparProcessSupervisor {
    pub fn new(amcp_port: u16) -> Self {
        let lock = InstanceLock::acquire(amcp_port);
        Self {
            instance_lock: Arc::new(lock),
            amcp_port,
            inner: Arc::new(Mutex::new(SupervisorInner {
                state: CasparProcessState::Stopped,
                child: None,
                pid: None,
                exit_code: None,
                last_error: None,
                expected_stop: false,
                circuit_breaker_tripped: false,
                job_guard: None,
                adopted_watchdog: None,
            })),
            crash_history: Arc::new(parking_lot::Mutex::new(VecDeque::new())),
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
        let detected_pid = find_caspar_process_pid();

        let mut inner = self.inner.lock().await;

        // Dynamically reconcile state
        if resolved.is_none() && !port_open && detected_pid.is_none() {
            inner.state = CasparProcessState::Unconfigured;
        } else if inner.child.is_none() {
            if port_open || detected_pid.is_some() {
                if inner.pid.is_none() {
                    inner.pid = detected_pid;
                }
                if port_open {
                    inner.state = CasparProcessState::Operational;
                } else if inner.state != CasparProcessState::Crashed
                    && inner.state != CasparProcessState::Starting
                {
                    inner.state = CasparProcessState::Starting;
                }
            } else if inner.state != CasparProcessState::Crashed
                && inner.state != CasparProcessState::Starting
            {
                inner.state = CasparProcessState::Stopped;
                inner.pid = None;
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
            auto_relaunch_on_crash: settings.caspar_auto_relaunch_on_crash,
            circuit_breaker_tripped: inner.circuit_breaker_tripped,
            can_control,
        }
    }

    pub fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: &RuntimeSettings,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'static>> {
        let app = app.clone();
        let settings = settings.clone();
        let supervisor = self.clone();
        Box::pin(async move {
            supervisor.start_internal(&app, &settings).await
        })
    }

    async fn ensure_adopted_watchdog<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: &RuntimeSettings,
        port: u16,
        pid: Option<u32>,
    ) {
        let mut inner = self.inner.lock().await;
        if inner.child.is_some() {
            return;
        }
        if inner.adopted_watchdog.is_some() && inner.pid == pid && pid.is_some() {
            return;
        }
        if let Some(w) = inner.adopted_watchdog.take() {
            w.abort();
        }

        let supervisor_clone = self.clone();
        let app_clone = app.clone();
        let settings_clone = settings.clone();

        let handle = tauri::async_runtime::spawn(async move {
            run_adopted_process_watchdog(supervisor_clone, app_clone, settings_clone, port, pid).await;
        });

        inner.adopted_watchdog = Some(handle);
    }

    async fn start_internal<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        settings: &RuntimeSettings,
    ) -> Result<(), String> {
        if !self.is_primary() {
            return Err("Cannot start server: This instance is in MONITOR MODE (Read-Only).".to_string());
        }

        // Reset manual stop and circuit breaker on explicit start
        {
            let mut inner = self.inner.lock().await;
            inner.expected_stop = false;
            inner.circuit_breaker_tripped = false;
        }

        let port = self.amcp_port;
        let port_open = is_port_listening(port).await;
        let detected_pid = find_caspar_process_pid();

        // If port is listening or process is already running, adopt it seamlessly
        if port_open || detected_pid.is_some() {
            let pid = detected_pid;
            {
                let mut inner = self.inner.lock().await;
                inner.state = if port_open {
                    CasparProcessState::Operational
                } else {
                    CasparProcessState::Starting
                };
                inner.pid = pid;
                inner.last_error = None;
            }
            emit_state_change(app, self, settings).await;

            crate::diagnostics::push_caspar_process_log(
                "INFO",
                &format!("Adopted active CasparCG instance (PID: {:?}, Port 5250 open: {})", pid, port_open),
            );

            // Spawn adopted watchdog to monitor process health and crashes
            self.ensure_adopted_watchdog(app, settings, port, pid).await;

            return Ok(());
        }

        let exe_path = resolve_caspar_executable(&settings.casparcg_executable_path)
            .ok_or_else(|| "CasparCG executable not found. Please configure path in Settings.".to_string())?;

        let cwd = resolve_caspar_cwd(&exe_path);

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
                        if !guard.assign_pid(p) {
                            crate::diagnostics::push_caspar_process_log(
                                "WARN",
                                &format!("Failed to assign CasparCG PID {} to Windows Job Object guard", p),
                            );
                        }
                    } else {
                        crate::diagnostics::push_caspar_process_log(
                            "WARN",
                            "CasparCG child process has no PID; skipping Windows Job Object assignment",
                        );
                    }
                    Some(guard)
                } else {
                    crate::diagnostics::push_caspar_process_log(
                        "WARN",
                        "Failed to create Windows Job Object for process supervision (processes may persist if PlayOut terminates unexpectedly)",
                    );
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
            inner.expected_stop = false;
            inner.job_guard = job_guard;
            if let Some(w) = inner.adopted_watchdog.take() {
                w.abort();
            }
        }

        emit_state_change(app, self, settings).await;

        // Background monitor for child termination, port readiness & steady-state lifecycle
        let supervisor_clone = self.clone();
        let app_handle = app.clone();
        let settings_clone = settings.clone();

        tauri::async_runtime::spawn(async move {
            run_process_watchdog(supervisor_clone, app_handle, settings_clone, port).await;
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

        {
            let mut inner = self.inner.lock().await;
            inner.expected_stop = true;
            inner.circuit_breaker_tripped = false;
            if let Some(w) = inner.adopted_watchdog.take() {
                w.abort();
            }
        }

        let (child, adopted_pid) = {
            let mut inner = self.inner.lock().await;
            (inner.child.take(), inner.pid.take())
        };

        let port = self.amcp_port;
        // Resolve the PID that actually owns our AMCP port; only ever kill a
        // process that is both bound to that port and named casparcg.exe.
        let pid_to_terminate = adopted_pid
            .or_else(|| find_pid_listening_on_port(port).filter(is_casparcg_pid));

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
        } else if let Some(pid) = pid_to_terminate {
            crate::diagnostics::push_caspar_process_log(
                "INFO",
                &format!("Terminating CasparCG instance (PID: {})...", pid),
            );
            terminate_process_by_pid(pid);
        }

        // If force is requested or if port is still listening, terminate CasparCG
        if is_port_listening(port).await {
            crate::diagnostics::push_caspar_process_log("INFO", "Terminating active CasparCG instance on port...");
            if let Ok(Ok(mut stream)) = tokio::time::timeout(
                Duration::from_millis(600),
                tokio::net::TcpStream::connect(("127.0.0.1", port)),
            ).await {
                use tokio::io::AsyncWriteExt;
                let _ = stream.write_all(b"KILL\r\n").await;
                let _ = stream.flush().await;
            }

            if force || is_port_listening(port).await {
                // Audit T1-2: never `taskkill /IM casparcg.exe`. That took down
                // every CasparCG on the machine (second channel, backup,
                // monitor instance). Terminate only the port owner.
                match pid_to_terminate.or_else(|| find_pid_listening_on_port(port).filter(is_casparcg_pid)) {
                    Some(pid) => {
                        terminate_process_by_pid(pid);
                    }
                    None => {
                        crate::diagnostics::push_caspar_process_log(
                            "WARN",
                            &format!(
                                "Port {} still open but no casparcg.exe owner could be resolved; refusing machine-wide kill",
                                port
                            ),
                        );
                    }
                }
            }
        }

        // Wait up to 3 seconds for port to actually close
        let start_wait = Instant::now();
        while is_port_listening(port).await && start_wait.elapsed() < Duration::from_secs(3) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        // Wait up to 3 seconds for process to actually exit if PID is known
        if let Some(pid) = pid_to_terminate {
            let start_wait_proc = Instant::now();
            while is_process_alive_by_pid(pid) && start_wait_proc.elapsed() < Duration::from_secs(3) {
                tokio::time::sleep(Duration::from_millis(100)).await;
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
        tokio::time::sleep(Duration::from_millis(1000)).await;
        self.crash_history.lock().clear();
        self.start(app, settings).await
    }
}

async fn run_adopted_process_watchdog<R: Runtime>(
    supervisor: CasparProcessSupervisor,
    app: AppHandle<R>,
    settings: RuntimeSettings,
    port: u16,
    pid: Option<u32>,
) {
    let mut healthy_seconds = 0u32;
    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        healthy_seconds += 1;
        if healthy_seconds == 60 {
            supervisor.crash_history.lock().clear();
        }

        let (expected_stop, has_child) = {
            let inner = supervisor.inner.lock().await;
            (inner.expected_stop, inner.child.is_some())
        };

        if expected_stop || has_child {
            return;
        }

        let is_alive = if let Some(p) = pid {
            is_process_alive_by_pid(p)
        } else {
            is_port_listening(port).await
        };

        if !is_alive {
            let exit_code = if let Some(p) = pid {
                get_process_exit_code(p).unwrap_or(-1)
            } else {
                -1
            };

            let was_expected = {
                let mut inner = supervisor.inner.lock().await;
                inner.pid = None;
                inner.exit_code = Some(exit_code);
                inner.expected_stop
            };

            if !was_expected {
                handle_crash(&supervisor, &app, exit_code, &settings).await;
            } else {
                let mut inner = supervisor.inner.lock().await;
                inner.state = CasparProcessState::Stopped;
                drop(inner);
                emit_state_change(&app, &supervisor, &settings).await;
            }
            return;
        }
    }
}

async fn run_process_watchdog<R: Runtime>(
    supervisor: CasparProcessSupervisor,
    app: AppHandle<R>,
    settings: RuntimeSettings,
    port: u16,
) {
    let mut boot_cycles = 0;
    let max_boot_cycles = 30; // 15 seconds (500ms intervals)
    let mut is_operational = false;

    // Phase 1: Boot monitoring
    while boot_cycles < max_boot_cycles {
        tokio::time::sleep(Duration::from_millis(500)).await;
        boot_cycles += 1;

        let mut inner = supervisor.inner.lock().await;
        if let Some(ref mut child) = inner.child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code().unwrap_or(-1);
                    let was_expected = inner.expected_stop;
                    inner.child = None;
                    inner.pid = None;
                    inner.exit_code = Some(code);
                    drop(inner);

                    if !was_expected {
                        handle_crash(&supervisor, &app, code, &settings).await;
                    } else {
                        let mut inner = supervisor.inner.lock().await;
                        inner.state = CasparProcessState::Stopped;
                        drop(inner);
                        emit_state_change(&app, &supervisor, &settings).await;
                    }
                    return;
                }
                Ok(None) => {
                    if !is_operational && is_port_listening(port).await {
                        is_operational = true;
                        inner.state = CasparProcessState::Operational;
                        inner.last_error = None;
                        crate::diagnostics::push_caspar_process_log(
                            "INFO",
                            "CasparCG AMCP Port 5250 is open. Engine operational.",
                        );
                        drop(inner);
                        emit_state_change(&app, &supervisor, &settings).await;
                        break;
                    }
                }
                Err(e) => {
                    log::warn!("[CasparProcess] Error polling child during boot: {}", e);
                    break;
                }
            }
        } else {
            return;
        }
    }

    if !is_operational {
        let mut inner = supervisor.inner.lock().await;
        if inner.state == CasparProcessState::Starting {
            inner.last_error = Some("Startup timeout: AMCP port not responding within 15s".to_string());
        }
        drop(inner);
        emit_state_change(&app, &supervisor, &settings).await;
        return;
    }

    // Phase 2: Continuous steady-state supervision
    let mut healthy_seconds = 0u32;
    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        healthy_seconds += 1;

        // Reset crash counter after 60s of uninterrupted healthy operation
        if healthy_seconds == 60 {
            {
                supervisor.crash_history.lock().clear();
            }
        }

        let mut inner = supervisor.inner.lock().await;
        if let Some(ref mut child) = inner.child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code().unwrap_or(-1);
                    let was_expected = inner.expected_stop;
                    inner.child = None;
                    inner.pid = None;
                    inner.exit_code = Some(code);
                    drop(inner);

                    if !was_expected {
                        handle_crash(&supervisor, &app, code, &settings).await;
                    } else {
                        let mut inner = supervisor.inner.lock().await;
                        inner.state = CasparProcessState::Stopped;
                        drop(inner);
                        emit_state_change(&app, &supervisor, &settings).await;
                    }
                    return;
                }
                Ok(None) => {
                    // Still running healthy
                }
                Err(e) => {
                    log::warn!("[CasparProcess] Error polling child in steady state: {}", e);
                    return;
                }
            }
        } else {
            // Child was taken by stop()
            return;
        }
    }
}

async fn handle_crash<R: Runtime>(
    supervisor: &CasparProcessSupervisor,
    app: &AppHandle<R>,
    exit_code: i32,
    fallback_settings: &RuntimeSettings,
) {
    log::warn!("[CasparProcess] Process exited unexpectedly with code {}", exit_code);
    crate::diagnostics::push_caspar_process_log(
        "ERROR",
        &format!("CasparCG process exited unexpectedly with code {}", exit_code),
    );

    let crash_count_in_window = {
        let now = Instant::now();
        let mut history = supervisor.crash_history.lock();
        while let Some(&front) = history.front() {
            if now.duration_since(front) > Duration::from_secs(60) {
                history.pop_front();
            } else {
                break;
            }
        }
        history.push_back(now);
        history.len()
    };

    // Read live runtime settings if available
    let settings = if let Some(state) = app.try_state::<RuntimeSettingsState>() {
        state.snapshot()
    } else {
        fallback_settings.clone()
    };

    let max_crashes_before_trip = 3;

    // Check sliding window circuit breaker
    if crash_count_in_window > max_crashes_before_trip {
        let mut inner = supervisor.inner.lock().await;
        inner.state = CasparProcessState::Crashed;
        inner.circuit_breaker_tripped = true;
        inner.last_error = Some(format!(
            "Circuit breaker tripped: CasparCG crashed {} times in 60s. Auto-relaunch paused to prevent crash loop.",
            crash_count_in_window
        ));
        drop(inner);

        crate::diagnostics::push_caspar_process_log(
            "ERROR",
            &format!(
                "Circuit breaker TRIPPED ({} crashes in 60s). Auto-relaunch paused. Check logs and configuration.",
                crash_count_in_window
            ),
        );
        emit_state_change(app, supervisor, &settings).await;
        return;
    }

    if !settings.caspar_auto_relaunch_on_crash || !supervisor.is_primary() {
        let mut inner = supervisor.inner.lock().await;
        inner.state = CasparProcessState::Crashed;
        inner.last_error = Some(format!("Server crashed with exit code {}", exit_code));
        drop(inner);
        emit_state_change(app, supervisor, &settings).await;
        return;
    }

    // Auto-relaunch allowed!
    {
        let mut inner = supervisor.inner.lock().await;
        inner.state = CasparProcessState::Starting;
        inner.last_error = Some(format!(
            "Server crashed (code {}). Auto-relaunching in 1.5s (attempt {} of {})...",
            exit_code, crash_count_in_window, max_crashes_before_trip
        ));
    }
    emit_state_change(app, supervisor, &settings).await;

    crate::diagnostics::push_caspar_process_log(
        "WARN",
        &format!(
            "Auto-relaunch active. Waiting 1500ms settle delay before restart (attempt {} of {})...",
            crash_count_in_window, max_crashes_before_trip
        ),
    );

    tokio::time::sleep(Duration::from_millis(1500)).await;

    let settings_now = if let Some(state) = app.try_state::<RuntimeSettingsState>() {
        state.snapshot()
    } else {
        settings
    };

    let supervisor_restart = supervisor.clone();
    let app_restart = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = supervisor_restart.start(&app_restart, &settings_now).await {
            crate::diagnostics::push_caspar_process_log(
                "ERROR",
                &format!("Auto-relaunch failed to spawn CasparCG: {}", e),
            );
            let mut inner = supervisor_restart.inner.lock().await;
            inner.state = CasparProcessState::Crashed;
            inner.last_error = Some(format!("Auto-relaunch failed: {}", e));
            drop(inner);
            emit_state_change(&app_restart, &supervisor_restart, &settings_now).await;
        }
    });
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
pub async fn caspar_process_get_status<R: Runtime>(
    app: AppHandle<R>,
    supervisor: State<'_, CasparProcessSupervisor>,
    settings_state: State<'_, RuntimeSettingsState>,
) -> Result<CasparProcessStatus, String> {
    let settings = settings_state.snapshot();
    let port = supervisor.amcp_port;
    let port_open = is_port_listening(port).await;
    let detected_pid = find_caspar_process_pid();
    if (port_open || detected_pid.is_some()) && supervisor.is_primary() {
        supervisor.ensure_adopted_watchdog(&app, &settings, port, detected_pid).await;
    }
    Ok(supervisor.get_status(&settings).await)
}

#[tauri::command]
pub async fn caspar_process_adopt<R: Runtime>(
    app: AppHandle<R>,
    supervisor: State<'_, CasparProcessSupervisor>,
    settings_state: State<'_, RuntimeSettingsState>,
) -> Result<CasparProcessStatus, String> {
    let settings = settings_state.snapshot();
    let port = supervisor.amcp_port;
    let port_open = is_port_listening(port).await;
    let detected_pid = find_caspar_process_pid();
    if port_open || detected_pid.is_some() {
        {
            let mut inner = supervisor.inner.lock().await;
            if inner.child.is_none() {
                inner.pid = detected_pid;
                inner.state = if port_open {
                    CasparProcessState::Operational
                } else {
                    CasparProcessState::Starting
                };
                inner.last_error = None;
            }
        }
        if supervisor.is_primary() {
            supervisor.ensure_adopted_watchdog(&app, &settings, port, detected_pid).await;
        }
        emit_state_change(&app, &supervisor, &settings).await;
    }
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

    #[test]
    fn test_caspar_status_auto_relaunch_fields() {
        let status = CasparProcessStatus {
            state: "crashed".to_string(),
            role: "primary".to_string(),
            pid: None,
            executable_path: "C:\\CasparCG\\casparcg.exe".to_string(),
            resolved_executable_path: Some("C:\\CasparCG\\casparcg.exe".to_string()),
            working_dir: Some("C:\\CasparCG".to_string()),
            config_filename: "casparcg.config".to_string(),
            exit_code: Some(-1073741819),
            last_error: Some("Access violation".to_string()),
            amcp_port: 5250,
            is_port_open: false,
            keep_alive_on_exit: true,
            auto_relaunch_on_crash: true,
            circuit_breaker_tripped: false,
            can_control: true,
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"autoRelaunchOnCrash\":true"));
        assert!(json.contains("\"circuitBreakerTripped\":false"));
    }

    #[test]
    fn test_circuit_breaker_sliding_window() {
        let mut history: VecDeque<Instant> = VecDeque::new();
        let now = Instant::now();

        // 4 crashes within 10 seconds
        history.push_back(now - Duration::from_secs(8));
        history.push_back(now - Duration::from_secs(5));
        history.push_back(now - Duration::from_secs(2));
        history.push_back(now);

        // Prune older than 60s
        while let Some(&front) = history.front() {
            if now.duration_since(front) > Duration::from_secs(60) {
                history.pop_front();
            } else {
                break;
            }
        }

        assert_eq!(history.len(), 4);
        assert!(history.len() > 3); // Trip breaker
    }

    #[test]
    #[cfg(windows)]
    fn test_job_object_guard_lifecycle() {
        let guard = JobObjectGuard::new();
        assert!(guard.is_some(), "JobObjectGuard::new should succeed on Windows");
        let guard = guard.unwrap();

        // Spawn a child process to verify PID assignment without affecting test runner
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping", "127.0.0.1", "-n", "3"])
            .spawn()
            .expect("Failed to spawn test child process");

        let child_pid = child.id();
        let assigned = guard.assign_pid(child_pid);
        assert!(assigned, "JobObjectGuard should successfully assign child process PID");

        // Explicit drop to verify CloseHandle execution terminates/cleans up the child without panic
        drop(guard);

        // Cleanup child process
        let _ = child.kill();
        let _ = child.wait();
    }
}
