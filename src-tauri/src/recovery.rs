//! recovery.rs — PlayOut's own crash recovery.
//!
//! The engine's recovery (CasparCG dies, PlayOut survives) lives in
//! `caspar_process.rs` and `services/caspar.ts`. This module covers the other
//! half: PlayOut itself dies, hangs, or its UI does.
//!
//! 1. **Checkpoint.** A small JSON file describing what is on air, written
//!    atomically (temp + fsync + rename) about once a second while a clip
//!    plays and at once on every take, advance, stop or graphics change. The
//!    frontend supplies the identity (row, playlist, trims, graphics); the
//!    position comes from the Rust playback state machine, so checkpoints keep
//!    flowing even while the UI is frozen.
//! 2. **Session journal.** Every launch is recorded; a clean exit marks its
//!    record. A launch finds out whether the previous session crashed, and
//!    several unclean exits in a short window are a crash loop.
//! 3. **As-run history.** The last `HISTORY_LEN` events, for post-incident review.
//! 4. **Auto-restart.** Windows Restart Manager relaunches PlayOut after a
//!    native crash or hang; a fatal main-thread panic relaunches it ourselves.
//!    Both pass `--recovered`, and both are off during a crash loop.
//! 5. **UI watchdog.** Rust pings the WebView; a UI that stops answering is
//!    reloaded, and if the reload does not bring it back, PlayOut relaunches.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Notify;

use crate::caspar::CasparPlaybackState;

const CHECKPOINT_VERSION: u32 = 1;
const HISTORY_LEN: usize = 50;
const SESSION_JOURNAL_LEN: usize = 20;
/// This many unclean exits inside the window is a crash loop.
pub const CRASH_LOOP_THRESHOLD: usize = 3;
pub const CRASH_LOOP_WINDOW_MS: u64 = 10 * 60 * 1000;
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(1);
const UI_PING_INTERVAL: Duration = Duration::from_secs(2);
/// A UI that has not answered a ping for this long is reloaded.
const UI_UNRESPONSIVE_AFTER: Duration = Duration::from_secs(12);
/// A reloaded UI that has not answered for this long gets a full relaunch.
const UI_RELOAD_GRACE: Duration = Duration::from_secs(25);
/// At most this many UI reloads per `UI_RELOAD_WINDOW` before giving up.
const UI_MAX_RELOADS: usize = 3;
const UI_RELOAD_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Command-line flag every automatic relaunch carries.
pub const RECOVERED_FLAG: &str = "--recovered";
/// `--wait-pid <pid>`: a relaunch waits for the process it replaces to exit.
pub const WAIT_PID_FLAG: &str = "--wait-pid";

static AUTO_RESTART_ALLOWED: AtomicBool = AtomicBool::new(false);
/// Set before a deliberate relaunch so the exit is journaled as unclean.
static EXITING_FOR_RECOVERY: AtomicBool = AtomicBool::new(false);

pub fn recovery_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.playout.client")
        .join("recovery")
}

fn checkpoint_path() -> PathBuf {
    recovery_dir().join("checkpoint.json")
}

fn history_path() -> PathBuf {
    recovery_dir().join("as-run-history.json")
}

fn sessions_path() -> PathBuf {
    recovery_dir().join("sessions.json")
}

pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// Identity of the on-air item, supplied by the frontend.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OnAirContext {
    /// Rundown row id (the queue key).
    pub uuid: String,
    pub playlist_id: Option<String>,
    pub path: String,
    pub filename: String,
    pub trim_in_ms: u64,
    pub trim_out_ms: u64,
    /// Length of the trimmed window, ms.
    pub duration_ms: u64,
    /// OSC positions count from here after a crash-resume SEEK.
    pub resume_offset_ms: u64,
    pub is_live: bool,
    pub next_uuid: Option<String>,
    pub next_path: Option<String>,
    pub play_generation: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphicsContext {
    pub advisory_on_air: bool,
    pub advisory_item: Option<serde_json::Value>,
    pub crawl_active: bool,
    pub crawl_text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckpointContext {
    pub on_air: Option<OnAirContext>,
    pub graphics: GraphicsContext,
    pub rundown_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnAirCheckpoint {
    #[serde(flatten)]
    pub context: OnAirContext,
    /// Position into the trimmed window, ms.
    pub position_ms: u64,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutCheckpoint {
    pub version: u32,
    pub seq: u64,
    pub session_id: String,
    pub written_at_ms: u64,
    pub on_air: Option<OnAirCheckpoint>,
    pub graphics: GraphicsContext,
    pub rundown_revision: u64,
    pub clean_shutdown: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub at_ms: u64,
    pub session_id: String,
    pub event: String,
    pub uuid: Option<String>,
    pub filename: Option<String>,
    pub position_ms: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    pub pid: u32,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub clean: bool,
    pub recovered_launch: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    /// Checkpoint left by the previous session (None on a first run).
    pub previous_checkpoint: Option<PlayoutCheckpoint>,
    pub previous_session: Option<SessionRecord>,
    /// The previous checkpoint was already handled by this session (the UI
    /// was reloaded): plan from `live_checkpoint` instead.
    pub previous_handled: bool,
    pub crash_loop: bool,
    pub recovered_launch: bool,
    pub ui_reloads: u32,
    /// This session's own checkpoint, built now.
    pub live_checkpoint: PlayoutCheckpoint,
}

/// The Rust playback registration, for a reloaded UI to re-sync from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePlayback {
    pub current_uuid: Option<String>,
    pub play_generation: u64,
    pub is_playing: bool,
    pub is_paused: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub trim_in_ms: u64,
    pub trim_out_ms: u64,
    pub current_path: String,
    pub expected_next_path: Option<String>,
    pub position_confirmed: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/// Number of unclean sessions that started inside the crash-loop window.
pub fn count_recent_crashes(sessions: &[SessionRecord], now_ms: u64) -> usize {
    sessions
        .iter()
        .filter(|s| !s.clean && now_ms.saturating_sub(s.started_at_ms) <= CRASH_LOOP_WINDOW_MS)
        .count()
}

/// Position of the on-air item into its trimmed window: the Rust clock when
/// it tracks the same row, else the last known position.
pub fn on_air_position(
    context: &OnAirContext,
    registered_uuid: Option<&str>,
    registered_position_ms: u64,
    last_known_ms: u64,
) -> u64 {
    if registered_uuid == Some(context.uuid.as_str()) {
        let position = registered_position_ms.saturating_add(context.resume_offset_ms);
        if context.duration_ms > 0 {
            position.min(context.duration_ms)
        } else {
            position
        }
    } else {
        last_known_ms
    }
}

/// Parse the `--wait-pid` value from a command line.
pub fn wait_pid_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<u32> {
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == WAIT_PID_FLAG {
            return iter.next().and_then(|v| v.parse().ok());
        }
    }
    None
}

fn new_session_id() -> String {
    format!("{:x}-{:x}", now_epoch_ms(), std::process::id())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &std::path::Path, value: &T) {
    match serde_json::to_vec_pretty(value) {
        Ok(bytes) => {
            if let Err(error) = crate::atomic_fs::write_atomic(path, &bytes) {
                log::warn!("[Recovery] Failed to write '{}': {}", path.display(), error);
            }
        }
        Err(error) => log::warn!("[Recovery] Failed to serialise '{}': {}", path.display(), error),
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Inner {
    session_id: String,
    context: CheckpointContext,
    last_position_ms: u64,
    dirty: bool,
    history_dirty: bool,
    seq: u64,
    history: VecDeque<HistoryEvent>,
    previous_checkpoint: Option<PlayoutCheckpoint>,
    previous_session: Option<SessionRecord>,
    previous_handled: bool,
    sessions: Vec<SessionRecord>,
    crash_loop: bool,
    recovered_launch: bool,
}

struct UiWatch {
    last_pong: Option<Instant>,
    reload_started: Option<Instant>,
    reloads: VecDeque<Instant>,
    gave_up: bool,
    total_reloads: u32,
}

#[derive(Clone)]
pub struct RecoveryState {
    inner: Arc<Mutex<Inner>>,
    ui: Arc<Mutex<UiWatch>>,
    wake: Arc<Notify>,
}

impl RecoveryState {
    /// Read what the previous session left and journal this launch.
    pub fn boot(recovered_launch: bool) -> Self {
        let _ = std::fs::create_dir_all(recovery_dir());
        let previous_checkpoint: Option<PlayoutCheckpoint> = read_json(&checkpoint_path());
        let mut sessions: Vec<SessionRecord> = read_json(&sessions_path()).unwrap_or_default();
        let history: VecDeque<HistoryEvent> = read_json::<Vec<HistoryEvent>>(&history_path())
            .map(VecDeque::from)
            .unwrap_or_default();
        let previous_session = sessions.last().cloned();
        let now = now_epoch_ms();
        let crash_loop = count_recent_crashes(&sessions, now) >= CRASH_LOOP_THRESHOLD;

        let session_id = new_session_id();
        sessions.push(SessionRecord {
            session_id: session_id.clone(),
            pid: std::process::id(),
            started_at_ms: now,
            ended_at_ms: None,
            clean: false,
            recovered_launch,
        });
        if sessions.len() > SESSION_JOURNAL_LEN {
            let excess = sessions.len() - SESSION_JOURNAL_LEN;
            sessions.drain(..excess);
        }
        write_json(&sessions_path(), &sessions);

        let state = Self {
            inner: Arc::new(Mutex::new(Inner {
                session_id,
                context: CheckpointContext::default(),
                last_position_ms: 0,
                dirty: false,
                history_dirty: false,
                seq: previous_checkpoint.as_ref().map(|c| c.seq).unwrap_or(0),
                history,
                previous_checkpoint,
                previous_session,
                previous_handled: false,
                sessions,
                crash_loop,
                recovered_launch,
            })),
            ui: Arc::new(Mutex::new(UiWatch {
                last_pong: None,
                reload_started: None,
                reloads: VecDeque::new(),
                gave_up: false,
                total_reloads: 0,
            })),
            wake: Arc::new(Notify::new()),
        };

        let detail = match (&state.inner.lock().previous_session, crash_loop) {
            (_, true) => Some("crash loop detected: automatic restart and resume are paused".to_string()),
            (Some(prev), _) if !prev.clean => Some("previous session ended unexpectedly".to_string()),
            _ => None,
        };
        state.note(if recovered_launch { "app-start (recovered)" } else { "app-start" }, None, None, None, detail);
        if crash_loop {
            log::error!("[Recovery] Crash loop: {} unclean exits within {} min", CRASH_LOOP_THRESHOLD, CRASH_LOOP_WINDOW_MS / 60_000);
            crate::diagnostics::push_caspar_process_log(
                "ERROR",
                "PlayOut crash loop detected: automatic restart and automatic resume are paused for this session",
            );
        }
        state
    }

    pub fn crash_loop(&self) -> bool {
        self.inner.lock().crash_loop
    }

    /// Append an as-run event (written by the checkpoint task).
    pub fn note(
        &self,
        event: &str,
        uuid: Option<String>,
        filename: Option<String>,
        position_ms: Option<u64>,
        detail: Option<String>,
    ) {
        let mut inner = self.inner.lock();
        let entry = HistoryEvent {
            at_ms: now_epoch_ms(),
            session_id: inner.session_id.clone(),
            event: event.to_string(),
            uuid,
            filename,
            position_ms,
            detail,
        };
        inner.history.push_back(entry);
        while inner.history.len() > HISTORY_LEN {
            inner.history.pop_front();
        }
        inner.history_dirty = true;
        drop(inner);
        self.wake.notify_one();
    }

    fn build_checkpoint(inner: &mut Inner, playback: &CasparPlaybackState, clean_shutdown: bool) -> PlayoutCheckpoint {
        let on_air = inner.context.on_air.clone().map(|context| {
            let s = playback.0.lock();
            let position = on_air_position(&context, s.current_uuid.as_deref(), s.position_ms, inner.last_position_ms);
            let paused = s.current_uuid.as_deref() == Some(context.uuid.as_str()) && s.is_paused;
            drop(s);
            inner.last_position_ms = position;
            OnAirCheckpoint { context, position_ms: position, paused }
        });
        inner.seq += 1;
        PlayoutCheckpoint {
            version: CHECKPOINT_VERSION,
            seq: inner.seq,
            session_id: inner.session_id.clone(),
            written_at_ms: now_epoch_ms(),
            on_air,
            graphics: inner.context.graphics.clone(),
            rundown_revision: inner.context.rundown_revision,
            clean_shutdown,
        }
    }

    /// Final checkpoint and session record on the way out.
    pub fn mark_exit(&self, playback: &CasparPlaybackState) {
        let clean = !EXITING_FOR_RECOVERY.load(Ordering::SeqCst);
        let mut inner = self.inner.lock();
        // Do not overwrite a previous session's checkpoint nobody handled
        // with an empty one.
        if inner.previous_handled || inner.context.on_air.is_some() {
            let checkpoint = Self::build_checkpoint(&mut inner, playback, clean);
            write_json(&checkpoint_path(), &checkpoint);
        }
        let session_id = inner.session_id.clone();
        if let Some(record) = inner.sessions.iter_mut().rev().find(|s| s.session_id == session_id) {
            record.ended_at_ms = Some(now_epoch_ms());
            record.clean = clean;
        }
        let entry = HistoryEvent {
            at_ms: now_epoch_ms(),
            session_id,
            event: if clean { "app-exit".to_string() } else { "app-exit (relaunching)".to_string() },
            uuid: None,
            filename: None,
            position_ms: None,
            detail: None,
        };
        inner.history.push_back(entry);
        while inner.history.len() > HISTORY_LEN {
            inner.history.pop_front();
        }
        write_json(&sessions_path(), &inner.sessions);
        write_json(&history_path(), &Vec::from(inner.history.clone()));
    }

    /// Checkpoint writer: every second while on air, at once on events.
    pub fn spawn_writer<R: Runtime>(&self, app: AppHandle<R>) {
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(CHECKPOINT_INTERVAL) => {}
                    _ = state.wake.notified() => {}
                }
                let Some(playback) = app.try_state::<CasparPlaybackState>() else { continue };
                let (checkpoint, history) = {
                    let mut inner = state.inner.lock();
                    let playing = inner.context.on_air.as_ref().is_some_and(|on_air| {
                        let s = playback.0.lock();
                        s.current_uuid.as_deref() == Some(on_air.uuid.as_str()) && s.is_playing && !s.is_paused
                    });
                    // Until the previous session's checkpoint is handled, only
                    // an on-air item may replace it.
                    let protect_previous = !inner.previous_handled && inner.context.on_air.is_none();
                    let checkpoint = if !protect_previous && (inner.dirty || playing) {
                        inner.dirty = false;
                        Some(Self::build_checkpoint(&mut inner, &playback, false))
                    } else {
                        None
                    };
                    let history = if inner.history_dirty {
                        inner.history_dirty = false;
                        Some(Vec::from(inner.history.clone()))
                    } else {
                        None
                    };
                    (checkpoint, history)
                };
                if checkpoint.is_none() && history.is_none() {
                    continue;
                }
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Some(checkpoint) = checkpoint {
                        write_json(&checkpoint_path(), &checkpoint);
                    }
                    if let Some(history) = history {
                        write_json(&history_path(), &history);
                    }
                })
                .await;
            }
        });
    }

    /// Ping the UI and reload or relaunch it when it stops answering.
    pub fn spawn_ui_watchdog<R: Runtime>(&self, app: AppHandle<R>) {
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(UI_PING_INTERVAL).await;
                let Some(window) = app.get_webview_window("main") else { continue };
                // `eval` runs through the WebView's script queue, which is not
                // subject to background-timer throttling: a minimised window
                // still answers, a hung or crashed renderer does not.
                let _ = window.eval("window.__playoutPing && window.__playoutPing()");

                enum Action {
                    None,
                    Reload,
                    Relaunch,
                }
                let action = {
                    let mut ui = state.ui.lock();
                    let now = Instant::now();
                    while ui.reloads.front().is_some_and(|t| now.duration_since(*t) > UI_RELOAD_WINDOW) {
                        ui.reloads.pop_front();
                    }
                    if ui.gave_up {
                        Action::None
                    } else if let Some(started) = ui.reload_started {
                        if now.duration_since(started) > UI_RELOAD_GRACE {
                            ui.gave_up = true;
                            Action::Relaunch
                        } else {
                            Action::None
                        }
                    } else if ui.last_pong.is_some_and(|t| now.duration_since(t) > UI_UNRESPONSIVE_AFTER) {
                        if ui.reloads.len() >= UI_MAX_RELOADS {
                            ui.gave_up = true;
                            log::error!("[Recovery] UI unresponsive again after {} reloads; watchdog stands down", UI_MAX_RELOADS);
                            Action::None
                        } else {
                            ui.reloads.push_back(now);
                            ui.total_reloads += 1;
                            ui.reload_started = Some(now);
                            ui.last_pong = None;
                            Action::Reload
                        }
                    } else {
                        Action::None
                    }
                };
                match action {
                    Action::None => {}
                    Action::Reload => {
                        log::error!("[Recovery] UI unresponsive for {} s; reloading it", UI_UNRESPONSIVE_AFTER.as_secs());
                        state.note("ui-reload", None, None, None, Some("UI stopped answering".to_string()));
                        if let Err(error) = window.reload() {
                            log::error!("[Recovery] UI reload failed: {}", error);
                        }
                    }
                    Action::Relaunch => {
                        log::error!("[Recovery] UI did not come back after a reload; relaunching PlayOut");
                        state.note("app-relaunch", None, None, None, Some("UI did not recover after a reload".to_string()));
                        relaunch_self(&app, "UI did not recover after a reload");
                    }
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Auto-restart
// ---------------------------------------------------------------------------

/// Register or unregister with Windows Restart Manager. Release builds only:
/// a debug build is started by `tauri dev` and cannot run without its dev
/// server.
pub fn sync_auto_restart(enabled: bool) {
    let allowed = enabled && cfg!(not(debug_assertions)) && !CRASH_LOOP.load(Ordering::SeqCst);
    AUTO_RESTART_ALLOWED.store(allowed, Ordering::SeqCst);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Recovery::{RegisterApplicationRestart, UnregisterApplicationRestart};
        if allowed {
            let wide: Vec<u16> = RECOVERED_FLAG.encode_utf16().chain(std::iter::once(0)).collect();
            // Flags 0: restart after a crash, a hang, an update and a reboot.
            // Windows only restarts a process that ran for at least 60 s,
            // which is itself a crash-loop brake.
            let hr = RegisterApplicationRestart(wide.as_ptr(), 0);
            if hr != 0 {
                log::warn!("[Recovery] RegisterApplicationRestart failed: 0x{:08x}", hr);
            }
        } else {
            let _ = UnregisterApplicationRestart();
        }
    }
}

static CRASH_LOOP: AtomicBool = AtomicBool::new(false);

pub fn set_crash_loop(active: bool) {
    CRASH_LOOP.store(active, Ordering::SeqCst);
}

pub fn auto_restart_allowed() -> bool {
    AUTO_RESTART_ALLOWED.load(Ordering::SeqCst)
}

/// Start a replacement process that waits for this one to exit. Used by the
/// panic hook (it cannot rely on an `AppHandle`) and by [`relaunch_self`].
pub fn spawn_replacement(reason: &str) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    EXITING_FOR_RECOVERY.store(true, Ordering::SeqCst);
    let mut command = std::process::Command::new(exe);
    command.arg(RECOVERED_FLAG).arg(WAIT_PID_FLAG).arg(std::process::id().to_string());
    match command.spawn() {
        Ok(child) => {
            log::error!("[Recovery] Relaunching PlayOut (pid {}): {}", child.id(), reason);
            true
        }
        Err(error) => {
            log::error!("[Recovery] Could not relaunch PlayOut: {}", error);
            false
        }
    }
}

fn relaunch_self<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    if !auto_restart_allowed() {
        log::error!("[Recovery] Relaunch needed ({}) but auto-restart is off", reason);
        return;
    }
    if spawn_replacement(reason) {
        app.exit(1);
    }
}

/// A relaunched instance waits here for the process it replaces, so the two
/// never hold the instance lock (or CasparCG) at once. Returns false when the
/// old process is still alive after the wait: it recovered, and this
/// replacement should quietly exit.
pub fn wait_for_predecessor<I: IntoIterator<Item = String>>(args: I) -> bool {
    let Some(pid) = wait_pid_from_args(args) else { return true };
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if !crate::caspar_process::is_process_alive_by_pid(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !crate::caspar_process::is_process_alive_by_pid(pid)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn recovery_boot_info(
    state: State<'_, RecoveryState>,
    playback: State<'_, CasparPlaybackState>,
) -> BootInfo {
    let ui_reloads = state.ui.lock().total_reloads;
    let mut inner = state.inner.lock();
    let live_checkpoint = RecoveryState::build_checkpoint(&mut inner, &playback, false);
    BootInfo {
        previous_checkpoint: inner.previous_checkpoint.clone(),
        previous_session: inner.previous_session.clone(),
        previous_handled: inner.previous_handled,
        crash_loop: inner.crash_loop,
        recovered_launch: inner.recovered_launch,
        ui_reloads,
        live_checkpoint,
    }
}

/// The frontend has acted on (or dismissed) the previous session's checkpoint.
#[tauri::command]
pub fn recovery_ack_previous(state: State<'_, RecoveryState>) {
    let mut inner = state.inner.lock();
    inner.previous_handled = true;
    inner.dirty = true;
    drop(inner);
    state.wake.notify_one();
}

/// Replace the on-air identity / graphics context and checkpoint at once.
#[tauri::command]
pub fn recovery_checkpoint_update(
    event: String,
    context: CheckpointContext,
    state: State<'_, RecoveryState>,
) {
    let (uuid, filename) = context
        .on_air
        .as_ref()
        .map(|o| (Some(o.uuid.clone()), Some(o.filename.clone())))
        .unwrap_or((None, None));
    {
        let mut inner = state.inner.lock();
        let same_item = match (&inner.context.on_air, &context.on_air) {
            (Some(a), Some(b)) => a.uuid == b.uuid && a.resume_offset_ms == b.resume_offset_ms,
            _ => false,
        };
        if !same_item {
            inner.last_position_ms = context.on_air.as_ref().map(|o| o.resume_offset_ms).unwrap_or(0);
        }
        inner.context = context;
        inner.dirty = true;
    }
    if event.is_empty() {
        // Context refresh only (e.g. graphics): checkpoint it, no as-run entry.
        state.wake.notify_one();
        return;
    }
    let position = state.inner.lock().last_position_ms;
    state.note(&event, uuid, filename, Some(position), None);
}

/// Record an as-run event without changing the context.
#[tauri::command]
pub fn recovery_note(
    event: String,
    uuid: Option<String>,
    filename: Option<String>,
    position_ms: Option<u64>,
    detail: Option<String>,
    state: State<'_, RecoveryState>,
) {
    state.note(&event, uuid, filename, position_ms, detail);
}

#[tauri::command]
pub fn recovery_history(state: State<'_, RecoveryState>) -> Vec<HistoryEvent> {
    Vec::from(state.inner.lock().history.clone())
}

/// Answer to the watchdog's ping. The first one arms the watchdog.
#[tauri::command]
pub fn recovery_ui_pong(state: State<'_, RecoveryState>) {
    let mut ui = state.ui.lock();
    ui.last_pong = Some(Instant::now());
    ui.reload_started = None;
}

/// The Rust playback registration. After a UI reload (same process) this is
/// the exact on-air identity; the UI re-syncs from it.
#[tauri::command]
pub fn recovery_live_playback(playback: State<'_, CasparPlaybackState>) -> LivePlayback {
    let s = playback.0.lock();
    LivePlayback {
        current_uuid: s.current_uuid.clone(),
        play_generation: s.play_generation,
        is_playing: s.is_playing,
        is_paused: s.is_paused,
        position_ms: s.position_ms,
        duration_ms: s.duration_ms,
        trim_in_ms: s.trim_in_ms,
        trim_out_ms: s.trim_out_ms,
        current_path: s.registered_current_path.clone(),
        expected_next_path: s.expected_next_path.clone(),
        position_confirmed: s.position_confirmation_emitted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(started_at_ms: u64, clean: bool) -> SessionRecord {
        SessionRecord {
            session_id: started_at_ms.to_string(),
            pid: 1,
            started_at_ms,
            ended_at_ms: None,
            clean,
            recovered_launch: false,
        }
    }

    #[test]
    fn crash_loop_counts_only_recent_unclean_sessions() {
        let now = 100 * 60 * 1000;
        let sessions = [
            session(now - 60 * 60 * 1000, false), // an hour ago: outside the window
            session(now - 9 * 60 * 1000, false),
            session(now - 5 * 60 * 1000, true),
            session(now - 60 * 1000, false),
        ];
        assert_eq!(count_recent_crashes(&sessions, now), 2);
    }

    #[test]
    fn position_follows_the_rust_clock_for_the_same_row_only() {
        let context = OnAirContext {
            uuid: "b".into(),
            duration_ms: 60_000,
            resume_offset_ms: 41_000,
            ..Default::default()
        };
        assert_eq!(on_air_position(&context, Some("b"), 5_000, 0), 46_000);
        assert_eq!(on_air_position(&context, Some("b"), 30_000, 0), 60_000, "clamped to the window");
        assert_eq!(on_air_position(&context, Some("a"), 5_000, 12_345), 12_345);
        assert_eq!(on_air_position(&context, None, 5_000, 777), 777);
    }

    #[test]
    fn wait_pid_is_parsed_from_the_command_line() {
        let args = ["aether.exe", "--recovered", "--wait-pid", "4242"].map(String::from);
        assert_eq!(wait_pid_from_args(args), Some(4242));
        assert_eq!(wait_pid_from_args(["aether.exe".to_string()]), None);
        assert_eq!(wait_pid_from_args(["x", "--wait-pid"].map(String::from)), None);
    }

    #[test]
    fn checkpoint_round_trips_with_flattened_on_air_fields() {
        let checkpoint = PlayoutCheckpoint {
            version: CHECKPOINT_VERSION,
            seq: 7,
            session_id: "s".into(),
            written_at_ms: 1,
            on_air: Some(OnAirCheckpoint {
                context: OnAirContext { uuid: "b".into(), next_uuid: Some("c".into()), ..Default::default() },
                position_ms: 42_000,
                paused: false,
            }),
            graphics: GraphicsContext { advisory_on_air: true, ..Default::default() },
            rundown_revision: 3,
            clean_shutdown: false,
        };
        let json = serde_json::to_string(&checkpoint).unwrap();
        assert!(json.contains("\"positionMs\":42000"));
        assert!(json.contains("\"uuid\":\"b\""));
        assert!(json.contains("\"nextUuid\":\"c\""));
        let back: PlayoutCheckpoint = serde_json::from_str(&json).unwrap();
        assert_eq!(back, checkpoint);
    }

    #[test]
    fn context_accepts_partial_json_from_the_frontend() {
        let context: CheckpointContext = serde_json::from_str(r#"{"onAir":null,"graphics":{"advisoryOnAir":true}}"#).unwrap();
        assert!(context.on_air.is_none());
        assert!(context.graphics.advisory_on_air);
    }
}
