//! AmcpClient — robust AMCP transport over a persistent, framed TCP connection.
//!
//! Replaces the per-command `TcpStream::connect` + fixed-4096-buffer read loop in
//! `caspar_send_command`. AMCP replies start with a 3-digit status code on the
//! first line; a reply is complete when a blank line (`\r\n\r\n`) terminates it
//! (multiline responses). See `.kilo/plans/...md` §1.2.
//!
//! Commands are serialized through a single `mpsc` channel so concurrent Tauri
//! commands do not interleave on the shared socket (AMCP is synchronous on one
//! connection — no request IDs needed).

use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::time::timeout;

const CASPAR_AMCP_ADDR: &str = "127.0.0.1:5250";
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_millis(3000);
/// Maximum time to wait for the AMCP status line *after sending a command*.
/// CasparCG replies asynchronously once the command actually executes —
/// producer initialization (image/video), file loads, etc. can take well over
/// a second. The 300ms `READ_GAP_TIMEOUT` is only valid for body data once
/// the status line has started arriving; using it on the status line made
/// every slow command abort, kill the connection, and get its reply delivered
/// to `[destroyed-connection]` (the erratic connect/disconnect churn).
pub(crate) const STATUS_LINE_TIMEOUT: Duration = Duration::from_secs(10);
/// Read-gap budget once a reply has started arriving (body data streams
/// continuously; a stall there means the peer hung).
pub(crate) const READ_GAP_TIMEOUT: Duration = Duration::from_millis(300);

/// Typed AMCP response.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct AmcpResponse {
    /// 3-digit status code (first line).
    pub code: u16,
    /// 2xx => ok, 4xx => error, 5xx => server error.
    pub status: AmcpStatus,
    /// Full raw body (status line + payload), with trailing whitespace trimmed.
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmcpStatus {
    Ok,
    Error,
    Server,
    Unknown,
}

impl AmcpStatus {
    pub fn from_code(code: u16) -> AmcpStatus {
        match code / 100 {
            2 => AmcpStatus::Ok,
            4 => AmcpStatus::Error,
            5 => AmcpStatus::Server,
            _ => AmcpStatus::Unknown,
        }
    }
}

impl AmcpResponse {
    #[allow(dead_code)]
    pub fn is_ok(&self) -> bool {
        self.status == AmcpStatus::Ok
    }
}

/// Validate an AMCP response for command success: 2xx codes are Ok, anything
/// else yields a typed error naming the status code and the payload. `cmd`
/// itself is NOT included here so the helper stays reusable/testable.
pub fn validate_amcp_response(resp: &AmcpResponse) -> Result<(), String> {
    if resp.is_ok() {
        return Ok(());
    }
    Err(format!("{:?} (code {})\n{}", resp.status, resp.code, resp.body))
}

/// One queued command awaiting its reply.
struct AmcpRequest {
    cmd: String,
    reply_tx: oneshot::Sender<Result<AmcpResponse, String>>,
}

/// Persistent AMCP client state managed by Tauri.
///
/// The connection task owns the socket; the public API enqueues commands through
/// the live sender held in `worker`. On transport failure the worker exits and is
/// lazily respawned on the next `send` (reconnect-on-demand), matching the
/// existing reconnect UX. All sends route through `worker` so a respawn can swap
/// in a fresh sender without rebinding an immutable field.
#[derive(Clone)]
pub struct AmcpClient {
    /// Serializes respawn so concurrent senders spawn at most one new worker.
    respawn: Arc<Mutex<()>>,
    /// Holds the live sender for the current worker; swapped on respawn.
    worker: Arc<AsyncMutex<mpsc::Sender<AmcpRequest>>>,
    /// When true, rejects mutating AMCP commands (Monitor / Read-Only mode).
    read_only: Arc<Mutex<bool>>,
}

/// Audit T2-3: AMCP is a CRLF-delimited line protocol. Any control character
/// inside a command (a `\r\n` smuggled into a file name, a settings string or
/// a template payload) would terminate the command early and let the
/// remainder execute as a second, unintended command on the on-air server.
/// Reject the whole command instead of trying to sanitise it: the caller's
/// input is broken and must not reach the wire.
pub fn validate_amcp_command(cmd: &str) -> Result<(), String> {
    let body = cmd.trim_end_matches(['\r', '\n']);
    if body.trim().is_empty() {
        return Err("AMCP command is empty".to_string());
    }
    if let Some(ch) = body.chars().find(|c| c.is_control()) {
        return Err(format!(
            "AMCP command rejected: contains control character U+{:04X}",
            ch as u32
        ));
    }
    Ok(())
}

/// Verbs the frontend may issue through the untyped `caspar_send_command`
/// passthrough (audit T2-2). Everything the app needs is here; server-control
/// and diagnostic verbs (`KILL`, `RESTART`, `GL GC`, `LOG`, `LOCK`, `SET`,
/// `DATA STORE`, `THUMBNAIL GENERATE_ALL`, ...) are deliberately absent so a
/// DOM-XSS in the WebView cannot take the server down or rewrite its state.
/// Process control goes through the supervisor, which is a separate command.
const ALLOWED_PASSTHROUGH_VERBS: &[&str] = &[
    "PLAY", "LOADBG", "LOAD", "STOP", "PAUSE", "RESUME", "CLEAR", "CALL", "SWAP",
    "ADD", "REMOVE", "MIXER", "CG", "INFO", "CLS", "TLS", "CINF", "VERSION", "PING",
    // PlayOut fork (`PLAYOUT-FORK.md` §4). A stock server answers `400`.
    "QUEUE", "ONAIR", "FALLBACK", "EVENTS",
];

/// Commands the fork accepts inside `ONAIR <ch>-<layer> <tag> <command>`
/// (`PLAYOUT-FORK.md` §3.4), restricted to the passthrough allow-list. The
/// fork verbs themselves are never nested.
const ALLOWED_ONAIR_VERBS: &[&str] = &[
    "PLAY", "LOADBG", "LOAD", "STOP", "PAUSE", "RESUME", "CLEAR", "CALL", "MIXER", "CG",
];

fn verb_in(verb: &str, list: &[&str]) -> bool {
    list.iter().any(|allowed| verb.eq_ignore_ascii_case(allowed))
}

/// Returns true if the leading verb of `cmd` is in the passthrough allow-list.
/// Commands with a request-id prefix (`REQ <id> <VERB>`) are checked on the
/// verb that follows the id. An `ONAIR` line is also checked on the command
/// it attaches.
pub fn is_allowed_passthrough_command(cmd: &str) -> bool {
    let mut tokens = cmd.split_whitespace();
    let Some(first) = tokens.next() else { return false };
    let verb = if first.eq_ignore_ascii_case("REQ") {
        // `REQ <id> <VERB>`
        tokens.next();
        match tokens.next() {
            Some(v) => v,
            None => return false,
        }
    } else {
        first
    };
    if verb.eq_ignore_ascii_case("ONAIR") {
        // `ONAIR <ch>-<layer> <tag> <VERB> …`
        let (Some(_), Some(tag), Some(inner)) = (tokens.next(), tokens.next(), tokens.next()) else {
            return false;
        };
        return is_valid_tag(tag) && verb_in(inner, ALLOWED_ONAIR_VERBS);
    }
    verb_in(verb, ALLOWED_PASSTHROUGH_VERBS)
}

/// Tag rule of the fork's `check_tag`: 1 to 128 of `A-Z a-z 0-9 . _ : -`.
/// Rundown row ids (uuids) and the `<id>:<n>` occurrence suffix both fit.
pub fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 128
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn check_tag(tag: &str) -> Result<&str, String> {
    if is_valid_tag(tag) {
        Ok(tag)
    } else {
        Err(format!("Invalid CasparCG item tag '{}'", tag))
    }
}

/// `EXPECT` accepts a tag or `-` ("no tagged item on air").
fn check_expect(expect: &str) -> Result<&str, String> {
    if expect == "-" {
        Ok(expect)
    } else {
        check_tag(expect)
    }
}

/// CG template names are interpolated unescaped into `CG ... ADD` (they are
/// CasparCG template-directory relative paths). Restrict them to a safe
/// character set so a name can never close the quoted token or inject a
/// second command.
pub fn is_safe_template_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ' '))
}

/// Returns true if an AMCP command is a safe telemetry/read-only query.
pub fn is_safe_read_only_command(cmd: &str) -> bool {
    let upper = cmd.trim().to_uppercase();
    upper.starts_with("INFO")
        || upper.starts_with("DIAG")
        || upper.starts_with("VERSION")
        || upper.starts_with("TLS")
        || upper.starts_with("CINF")
        || upper.starts_with("GL INFO")
        || upper.starts_with("HELP")
        || upper.starts_with("BYE")
        || upper.starts_with("PING")
        || upper.starts_with("DATA RETRIEVE")
        || upper.starts_with("EVENTS")
        || is_queue_info_command(&upper)
}

/// `QUEUE <ch>-<layer> INFO` and nothing else (every other `QUEUE` form mutates).
fn is_queue_info_command(upper: &str) -> bool {
    let tokens: Vec<&str> = upper.split_whitespace().collect();
    matches!(tokens.as_slice(), ["QUEUE", _, "INFO"])
}

impl AmcpClient {
    /// Spawn a fresh worker bound to a new mpsc channel and return its sender.
    fn spawn_worker() -> mpsc::Sender<AmcpRequest> {
        let (tx, rx) = mpsc::channel::<AmcpRequest>(64);
        tauri::async_runtime::spawn(amcp_worker(rx));
        tx
    }

    /// Create a client with a worker already running (connection attempt happens
    /// lazily on first `send`).
    pub fn new() -> Self {
        let tx = Self::spawn_worker();
        AmcpClient {
            respawn: Arc::new(Mutex::new(())),
            worker: Arc::new(AsyncMutex::new(tx)),
            read_only: Arc::new(Mutex::new(false)),
        }
    }

    /// Update the read-only / monitor mode state.
    pub fn set_read_only(&self, read_only: bool) {
        *self.read_only.lock() = read_only;
    }

    /// Query whether monitor mode is active.
    pub fn is_read_only(&self) -> bool {
        *self.read_only.lock()
    }

    /// Send a single AMCP command and await its framed reply.
    pub async fn send(&self, cmd: &str) -> Result<AmcpResponse, String> {
        validate_amcp_command(cmd)?;
        if self.is_read_only() && !is_safe_read_only_command(cmd) {
            return Err(format!(
                "AMCP command '{}' rejected: Instance is running in MONITOR MODE (Read-Only).",
                cmd.trim()
            ));
        }

        let normalized = if cmd.ends_with("\r\n") {
            cmd.to_string()
        } else {
            format!("{}\r\n", cmd.trim_end())
        };

        let mut attempts = 0;
        loop {
            attempts += 1;

            let (reply_tx, reply_rx) = oneshot::channel();
            let req = AmcpRequest {
                cmd: normalized.clone(),
                reply_tx,
            };

            // Clone the sender and drop the worker mutex guard BEFORE awaiting
            // the channel send, so concurrent callers are never blocked on this
            // request's queueing.
            let send_result = {
                let tx = self.worker.lock().await.clone();
                tx.send(req).await
            };

            // If the channel is closed (worker died), respawn before retrying.
            if let Err(_send_err) = send_result {
                if attempts >= 2 {
                    return Err("AMCP worker unavailable after respawn".to_string());
                }
                self.respawn_worker().await;
                continue;
            }

            match reply_rx.await {
                Ok(res) => return res,
                Err(_) => {
                    // Worker dropped the reply (transport error mid-read); respawn.
                    self.respawn_worker().await;
                    return Err(
                        "AMCP worker dropped the reply before responding".to_string(),
                    );
                }
            }
        }
    }

    async fn respawn_worker(&self) {
        // Serialize respawns under a sync lock, but release it before awaiting
        // the async worker mutex (the parking_lot guard is not `Send`).
        let new_tx = {
            let _guard = self.respawn.lock();
            Self::spawn_worker()
        };
        let mut worker_guard = self.worker.lock().await;
        *worker_guard = new_tx;
    }
}

/// The owning worker loop: holds the socket, reads framed replies, matches them
/// to the single in-flight request (AMCP is synchronous on one connection).
async fn amcp_worker(mut rx: mpsc::Receiver<AmcpRequest>) {
    // Lazily connect on the first command.
    let mut stream: Option<TcpStream> = None;

    while let Some(req) = rx.recv().await {
        // Ensure a live connection.
        if stream.is_none() {
            match timeout(CONNECT_TIMEOUT, TcpStream::connect(CASPAR_AMCP_ADDR)).await {
                Ok(Ok(s)) => stream = Some(s),
                Ok(Err(e)) => {
                    let _ = req.reply_tx.send(Err(format!(
                        "Failed to connect to CasparCG at {}: {}",
                        CASPAR_AMCP_ADDR, e
                    )));
                    continue;
                }
                Err(_) => {
                    let _ = req.reply_tx.send(Err(format!(
                        "Timed out connecting to CasparCG at {}",
                        CASPAR_AMCP_ADDR
                    )));
                    continue;
                }
            }
        }

        let Some(ref mut s) = stream else {
            let _ = req
                .reply_tx
                .send(Err("AMCP socket unavailable".to_string()));
            continue;
        };

        // Send command.
        match timeout(COMMAND_TIMEOUT, s.write_all(req.cmd.as_bytes())).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                stream = None;
                let _ = req.reply_tx.send(Err(format!(
                    "Failed to send CasparCG command: {}",
                    e
                )));
                continue;
            }
            Err(_) => {
                stream = None;
                let _ = req
                    .reply_tx
                    .send(Err("Timed out sending CasparCG command".to_string()));
                continue;
            }
        }

        // Read framed reply (status line + body until blank line or timeout).
        match read_framed_reply(s).await {
            Ok(body) => {
                let (code, status) = parse_status(&body);
                let _ = req.reply_tx.send(Ok(AmcpResponse {
                    code,
                    status,
                    body: body.trim().to_string(),
                }));
            }
            Err(e) => {
                stream = None;
                let _ = req.reply_tx.send(Err(format!(
                    "Failed to read CasparCG response: {}",
                    e
                )));
            }
        }
    }
}

/// Read a complete AMCP reply, framed by its status code:
///
/// - `200` (data block): status line + data terminated by a blank line
///   (`\r\n\r\n`).
/// - `201` (single data line): status line + exactly one more line.
/// - `400` (unknown command): status line + the echoed command line.
/// - everything else (`202` ack, `401`-`404`, `5xx`): the status line alone.
///
/// Previously every reply waited for the `\r\n\r\n` terminator or the 300 ms
/// read-gap timeout, so single-line acks (e.g. `202 PLAY OK`) stalled every
/// command by 300 ms. Framing on the status code returns them immediately.
///
/// The status line is waited on with `STATUS_LINE_TIMEOUT` (CasparCG executes
/// commands asynchronously and may take seconds to ack a PLAY while the
/// producer initializes), while body data keeps the short `READ_GAP_TIMEOUT`.
async fn read_framed_reply(stream: &mut TcpStream) -> Result<String, String> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 4096];

    // Status line must always arrive; EOF or a gap here is a transport error.
    read_until(stream, &mut buf, &mut chunk, 0, b"\r\n", true, STATUS_LINE_TIMEOUT).await?;

    let (code, _) = parse_status(&String::from_utf8_lossy(&buf));
    match code {
        200 => {
            // Data block until the blank-line terminator.
            read_until(stream, &mut buf, &mut chunk, 0, b"\r\n\r\n", false, READ_GAP_TIMEOUT).await?;
        }
        201 | 400 => {
            // 201: exactly one more line after the status line.
            // 400: CasparCG 2.x answers a malformed/unknown command with
            // `400 ERROR\r\n<echo of the command>\r\n`. Without draining the
            // echo line it would be read as the status line of the *next*
            // command and every subsequent reply would be off by one
            // (audit T2-9). The drain is best-effort (`require = false`), so
            // a server that sends a bare `400 ERROR` only costs one read-gap.
            let first_nl = buf
                .windows(2)
                .position(|w| w == b"\r\n")
                .map(|p| p + 2)
                .unwrap_or(buf.len());
            read_until(stream, &mut buf, &mut chunk, first_nl, b"\r\n", false, READ_GAP_TIMEOUT).await?;
        }
        _ => {}
    }

    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Read chunks until `buf[start..]` contains `terminator`, EOF, or the read
/// timeout fires. When `require` is set, EOF/timeout before any terminator is
/// an error; otherwise the partial buffer is accepted as complete.
async fn read_until(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    chunk: &mut [u8; 4096],
    start: usize,
    terminator: &[u8],
    require: bool,
    gap_timeout: Duration,
) -> Result<(), String> {
    let done = |buf: &Vec<u8>| {
        buf[start.min(buf.len())..]
            .windows(terminator.len())
            .any(|w| w == terminator)
    };

    while !done(buf) {
        match timeout(gap_timeout, stream.read(chunk)).await {
            Ok(Ok(0)) => {
                if require {
                    return Err("connection closed before AMCP status line".to_string());
                }
                break;
            }
            Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => {
                if require {
                    return Err("timed out reading AMCP status line".to_string());
                }
                break;
            }
        }
    }
    Ok(())
}

/// Parse the 3-digit status code from the first line of an AMCP reply.
fn parse_status(body: &str) -> (u16, AmcpStatus) {
    let first_line = body.lines().next().unwrap_or("").trim();
    // Status code is the leading 3 digits.
    let code = first_line
        .chars()
        .take(3)
        .collect::<String>()
        .parse::<u16>()
        .unwrap_or(0);
    (code, AmcpStatus::from_code(code))
}

/// Escape inner `"` as `\"` for AMCP shell-wrapped data tokens.
/// `serde_json` already produced a valid JSON string; this only escapes the
/// quotes so the whole token can be wrapped in `"..."` on the AMCP command line.
pub fn escape_amcp_data(json: &str) -> String {
    json.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Escape the data of a `CG ADD`/`CG UPDATE` for an HTML template.
///
/// CasparCG's html producer splices the data into `update("<data>")` and
/// escapes only `"` on the way, so any backslash in the JSON (`\"` around a
/// quote in the advisory text, `\\`, `\n`) would end or corrupt that JS
/// string literal: the template then throws a SyntaxError and keeps showing
/// the previous item's advisory. Doubling the backslashes first makes the
/// template receive the JSON unchanged; `escape_amcp_data` then escapes the
/// result for the AMCP token. Checked live against the fork (2.5.1 code).
pub fn escape_cg_data(json: &str) -> String {
    escape_amcp_data(&json.replace('\\', "\\\\"))
}

/// Build a `CG <ch>-<layer> ADD <index> "<template>" <play> "<data>"` command.
pub fn cg_add_cmd(
    channel: u8,
    layer: u16,
    index: u16,
    template: &str,
    play: bool,
    data: &str,
) -> String {
    format!(
        "CG {}-{} ADD {} \"{}\" {} \"{}\"",
        channel,
        layer,
        index,
        template,
        if play { 1 } else { 0 },
        escape_cg_data(data)
    )
}

/// Build a `CG <ch>-<layer> UPDATE <index> "<data>"` command.
pub fn cg_update_cmd(channel: u8, layer: u16, index: u16, data: &str) -> String {
    format!(
        "CG {}-{} UPDATE {} \"{}\"",
        channel,
        layer,
        index,
        escape_cg_data(data)
    )
}

/// Build a `CG <ch>-<layer> PLAY <index>` command.
pub fn cg_play_cmd(channel: u8, layer: u16, index: u16) -> String {
    format!("CG {}-{} PLAY {}", channel, layer, index)
}

/// Build a `CG <ch>-<layer> STOP <index>` command.
pub fn cg_stop_cmd(channel: u8, layer: u16, index: u16) -> String {
    format!("CG {}-{} STOP {}", channel, layer, index)
}

/// Build a `PLAY <ch>-<layer> "<path>"` image producer command.
pub fn play_image_cmd(channel: u8, layer: u16, path: &str) -> String {
    format!("PLAY {}-{} \"{}\"", channel, layer, path)
}

/// Build a `CLEAR <ch>-<layer>` command.
pub fn clear_layer_cmd(channel: u8, layer: u16) -> String {
    format!("CLEAR {}-{}", channel, layer)
}

/// Build a `LOADBG <ch>-<layer> "path"[ SEEK X][ LENGTH Y][ AUTO]` command.
/// SEEK is only appended for a non-zero IN point; LENGTH is only appended for
/// a non-degenerate trim window (OUT > IN). A stale or inflated IN point
/// (where the caller has already clamped OUT <= IN) produces a clean LOADBG
/// so a bogus SEEK can never jump the producer past the start of the file.
#[allow(dead_code)]
pub fn loadbg_cmd(
    channel: u8,
    layer: u16,
    path: &str,
    in_frame: u32,
    out_frame: u32,
    auto: bool,
) -> String {
    let mut cmd = format!("LOADBG {}-{} \"{}\"", channel, layer, path);
    if out_frame > in_frame {
        if in_frame > 0 {
            cmd.push_str(&format!(" SEEK {}", in_frame));
        }
        let length = out_frame.saturating_sub(in_frame);
        if length > 0 {
            cmd.push_str(&format!(" LENGTH {}", length));
        }
    }
    if auto {
        cmd.push_str(" AUTO");
    }
    cmd
}

/// Build a `PLAY <ch>-<layer> "path"[ SEEK X][ LENGTH Y]` command. This is
/// the critical path for manual takes: a stale frontend IN point must NEVER
/// inject a SEEK that skips the start of the clip. When the trim is absent or
/// degenerate (OUT <= IN) the command degrades to a clean PLAY. SEEK is only
/// appended for a non-zero IN; LENGTH is only appended for a real trim window.
#[allow(dead_code)]
pub fn play_trimmed_cmd(
    channel: u8,
    layer: u16,
    path: &str,
    in_frame: u32,
    out_frame: u32,
) -> String {
    let mut cmd = format!("PLAY {}-{} \"{}\"", channel, layer, path);
    if out_frame > in_frame {
        if in_frame > 0 {
            cmd.push_str(&format!(" SEEK {}", in_frame));
        }
        let length = out_frame.saturating_sub(in_frame);
        if length > 0 {
            cmd.push_str(&format!(" LENGTH {}", length));
        }
    }
    cmd
}

// ── PlayOut fork commands (`D:\casparcg-fork\PLAYOUT-FORK.md` §4) ──────────

/// Append `TAG <tag>` and `EXPECT <tag>` to a `PLAY`/`LOAD`/`LOADBG`/`QUEUE`
/// line. The fork strips both before the producer sees its parameters.
pub fn with_tag(cmd: String, tag: Option<&str>, expect: Option<&str>) -> Result<String, String> {
    let mut cmd = cmd;
    if let Some(tag) = tag {
        cmd.push_str(&format!(" TAG {}", check_tag(tag)?));
    }
    if let Some(expect) = expect {
        cmd.push_str(&format!(" EXPECT {}", check_expect(expect)?));
    }
    Ok(cmd)
}

/// How a tagged item reaches the layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemVerb {
    /// Append to the wait queue.
    Queue,
    /// Replace the background only; the queue behind it stays.
    Loadbg,
    /// A take: drops the background and the queue.
    Play,
}

impl ItemVerb {
    fn as_str(self) -> &'static str {
        match self {
            ItemVerb::Queue => "QUEUE",
            ItemVerb::Loadbg => "LOADBG",
            ItemVerb::Play => "PLAY",
        }
    }
}

/// One tagged clip. `seek`/`length` are channel units (fields on an
/// interlaced channel), already decided by the caller's trim rules
/// (`trimCommands.ts` `computeTrimFields`): `None` omits the parameter.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggedItem {
    pub path: String,
    #[serde(default)]
    pub seek: Option<u32>,
    #[serde(default)]
    pub length: Option<u32>,
    #[serde(default)]
    pub auto: bool,
    pub tag: String,
    #[serde(default)]
    pub expect: Option<String>,
}

/// `<VERB> <ch>-<layer> "<path>"[ SEEK X][ LENGTH Y][ AUTO] TAG <tag>[ EXPECT <tag>]`.
/// Fork items are always tagged: an untagged item makes no events. `AUTO`
/// is ignored for `PLAY`. A zero `SEEK` or `LENGTH` is never sent.
pub fn tagged_item_cmd(verb: ItemVerb, channel: u8, layer: u16, item: &TaggedItem) -> Result<String, String> {
    if item.path.trim().is_empty() || item.path.contains('"') {
        return Err(format!("Invalid CasparCG clip path '{}'", item.path));
    }
    let mut cmd = format!("{} {}-{} \"{}\"", verb.as_str(), channel, layer, item.path);
    if let Some(seek) = item.seek.filter(|&s| s > 0) {
        cmd.push_str(&format!(" SEEK {}", seek));
    }
    if let Some(length) = item.length.filter(|&l| l > 0) {
        cmd.push_str(&format!(" LENGTH {}", length));
    }
    if item.auto && verb != ItemVerb::Play {
        cmd.push_str(" AUTO");
    }
    with_tag(cmd, Some(&item.tag), item.expect.as_deref())
}

/// `QUEUE <ch>-<layer> CLEAR[ AFTER <tag>][ EXPECT <tag>]`. Without `after`
/// it drops the background and the whole queue.
pub fn queue_clear_cmd(
    channel: u8,
    layer: u16,
    after: Option<&str>,
    expect: Option<&str>,
) -> Result<String, String> {
    let mut cmd = format!("QUEUE {}-{} CLEAR", channel, layer);
    if let Some(after) = after {
        cmd.push_str(&format!(" AFTER {}", check_tag(after)?));
    }
    with_tag(cmd, None, expect)
}

/// `QUEUE <ch>-<layer> REMOVE <tag>[ EXPECT <tag>]`.
pub fn queue_remove_cmd(
    channel: u8,
    layer: u16,
    tag: &str,
    expect: Option<&str>,
) -> Result<String, String> {
    with_tag(format!("QUEUE {}-{} REMOVE {}", channel, layer, check_tag(tag)?), None, expect)
}

/// `QUEUE <ch>-<layer> INFO`: `201` + one line of JSON ([`QueueInfo`]).
pub fn queue_info_cmd(channel: u8, layer: u16) -> String {
    format!("QUEUE {}-{} INFO", channel, layer)
}

/// `ONAIR <ch>-<layer> <tag> <inner>`. `inner` must be a single command the
/// fork can attach (§3.4) and must itself pass the passthrough allow-list.
pub fn onair_cmd(channel: u8, layer: u16, tag: &str, inner: &str) -> Result<String, String> {
    validate_amcp_command(inner)?;
    let inner = inner.trim();
    let verb = inner.split_whitespace().next().unwrap_or("");
    if !verb_in(verb, ALLOWED_ONAIR_VERBS) {
        return Err(format!("AMCP verb '{}' cannot run as an ONAIR action", verb));
    }
    Ok(format!("ONAIR {}-{} {} {}", channel, layer, check_tag(tag)?, inner))
}

/// `FALLBACK <ch>-<layer> "<clip>"[ LOOP] TAG <tag>[ STALL <ticks>]`.
pub fn fallback_cmd(
    channel: u8,
    layer: u16,
    clip: &str,
    looped: bool,
    tag: &str,
    stall_ticks: Option<u32>,
) -> Result<String, String> {
    if clip.is_empty() || clip.contains('"') {
        return Err(format!("Invalid fallback clip '{}'", clip));
    }
    let mut cmd = format!("FALLBACK {}-{} \"{}\"", channel, layer, clip);
    if looped {
        cmd.push_str(" LOOP");
    }
    cmd = with_tag(cmd, Some(tag), None)?;
    if let Some(ticks) = stall_ticks {
        cmd.push_str(&format!(" STALL {}", ticks));
    }
    Ok(cmd)
}

/// `FALLBACK <ch>-<layer> CLEAR`: removes the clip; the STALL limit stays.
pub fn fallback_clear_cmd(channel: u8, layer: u16) -> String {
    format!("FALLBACK {}-{} CLEAR", channel, layer)
}

/// `FALLBACK <ch>-<layer> STALL <ticks>` (`0` = off).
pub fn fallback_stall_cmd(channel: u8, layer: u16, ticks: u32) -> String {
    format!("FALLBACK {}-{} STALL {}", channel, layer, ticks)
}

/// `EVENTS <ch>-<layer>[ <seq>]`: the events after `since`, oldest first.
pub fn events_cmd(channel: u8, layer: u16, since: Option<u64>) -> String {
    match since {
        Some(seq) => format!("EVENTS {}-{} {}", channel, layer, seq),
        None => format!("EVENTS {}-{}", channel, layer),
    }
}

/// `foreground` of `QUEUE INFO`. `tag` is empty for an untagged item;
/// `frames` is `-1` for an endless producer. Both count fields on an
/// interlaced channel.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QueueForeground {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub producer: String,
    #[serde(default)]
    pub frame: i64,
    #[serde(default)]
    pub frames: i64,
    #[serde(default)]
    pub paused: bool,
    /// A take that has not shown its first frame yet.
    #[serde(default)]
    pub starting: bool,
}

/// One waiting item: the background first, then the queue.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QueueWaiting {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub producer: String,
    #[serde(default)]
    pub auto: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QueueFallback {
    #[serde(default)]
    pub set: bool,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub stall: i64,
}

/// `QUEUE INFO` reply. `instance` is the server start time in ms; a new
/// value means the engine restarted and the queue is gone.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct QueueInfo {
    pub channel: u32,
    pub layer: u32,
    pub instance: i64,
    pub frame: i64,
    #[serde(default)]
    pub event_seq: u64,
    pub foreground: Option<QueueForeground>,
    #[serde(default)]
    pub waiting: Vec<QueueWaiting>,
    #[serde(default)]
    pub fallback: QueueFallback,
}

/// One engine event (`PLAYOUT-FORK.md` §3.6). `kind` is `onair`, `offair`,
/// `ended`, `stalled` or `actionfailed`; `time` is wall-clock ms.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct EngineEvent {
    pub seq: u64,
    pub frame: i64,
    #[serde(alias = "time_ms", rename(serialize = "timeMs"))]
    pub time: i64,
    pub kind: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub reason: String,
}

/// `EVENTS` reply. `since < oldest - 1` means events fell out of the log.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct EventsReply {
    pub channel: u32,
    pub layer: u32,
    pub instance: i64,
    pub frame: i64,
    pub last: u64,
    pub oldest: u64,
    #[serde(default)]
    pub events: Vec<EngineEvent>,
    /// Set by the caller: events after the requested seq fell out of the log.
    #[serde(default, skip_deserializing)]
    pub lost: bool,
}

impl EventsReply {
    /// True when the events after `since` are no longer all in the log.
    pub fn lost_events_after(&self, since: u64) -> bool {
        self.oldest > 0 && since + 1 < self.oldest
    }
}

/// The JSON line of a `201` fork reply (`201 QUEUE INFO OK\r\n{…}`).
fn reply_json_line(body: &str) -> Result<&str, String> {
    let mut lines = body.lines();
    let status = lines.next().unwrap_or("").trim();
    if !status.starts_with("201") {
        return Err(format!("Unexpected CasparCG reply: {}", status));
    }
    lines
        .map(str::trim)
        .find(|line| line.starts_with('{'))
        .ok_or_else(|| format!("CasparCG reply has no JSON line: {}", status))
}

pub fn parse_queue_info(body: &str) -> Result<QueueInfo, String> {
    serde_json::from_str(reply_json_line(body)?)
        .map_err(|error| format!("Invalid QUEUE INFO JSON: {}", error))
}

pub fn parse_events(body: &str) -> Result<EventsReply, String> {
    serde_json::from_str(reply_json_line(body)?)
        .map_err(|error| format!("Invalid EVENTS JSON: {}", error))
}

/// `QUEUE CLEAR` replies `201 QUEUE CLEAR OK` and the count on the next line.
pub fn parse_queue_clear_count(body: &str) -> Option<u32> {
    let mut lines = body.lines();
    if !lines.next()?.trim().starts_with("201") {
        return None;
    }
    lines.next()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caspar_layers::PROGRAM_CHANNEL;
    use tokio::io::AsyncWriteExt;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::Instant;

    /// Bind a loopback listener and serve `payload` to the first client.
    async fn serve_reply(payload: &'static [u8]) -> (TcpStream, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = sock.write_all(payload).await;
        });
        let client = TcpStream::connect(addr).await.unwrap();
        (client, server)
    }

    #[test]
    fn parse_status_ok() {
        let (code, status) = parse_status("202 CG OK\r\n");
        assert_eq!(code, 202);
        assert_eq!(status, AmcpStatus::Ok);
    }

    #[test]
    fn validate_amcp_response_accepts_2xx() {
        let resp = AmcpResponse {
            code: 200,
            status: AmcpStatus::Ok,
            body: "200 OK\r\n".to_string(),
        };
        assert!(validate_amcp_response(&resp).is_ok());
    }

    #[test]
    fn validate_amcp_response_rejects_4xx_with_code_and_body() {
        let resp = AmcpResponse {
            code: 404,
            status: AmcpStatus::Error,
            body: "404 FILE_NOT_FOUND\r\n".to_string(),
        };
        let err = validate_amcp_response(&resp).unwrap_err();
        assert!(err.contains("404"), "error should carry the status code: {err}");
        assert!(err.contains("FILE_NOT_FOUND"), "error should carry the payload: {err}");
    }

    #[test]
    fn validate_amcp_response_rejects_5xx() {
        let resp = AmcpResponse {
            code: 501,
            status: AmcpStatus::Server,
            body: "501 SERVER ERROR\r\n".to_string(),
        };
        assert!(validate_amcp_response(&resp).is_err());
    }

    /// The core framing fix: a `202` ack must return as soon as the status
    /// line is complete, NOT after the 300 ms read-gap timeout. Any stall is
    /// an order of magnitude larger than the allowed bound.
    #[tokio::test]
    async fn read_framed_reply_202_returns_without_read_gap_stall() {
        let (mut client, server) = serve_reply(b"202 PLAY OK\r\n").await;
        let start = Instant::now();
        let body = read_framed_reply(&mut client).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(body, "202 PLAY OK\r\n");
        assert!(
            elapsed < Duration::from_millis(200),
            "202 ack stalled for {elapsed:?} (read-gap regression)"
        );
        server.await.unwrap();
    }

    /// `200` replies carry a data block terminated by a blank line.
    #[tokio::test]
    async fn read_framed_reply_200_reads_until_blank_line() {
        let payload = b"200 OK\r\nmedia/A\r\nmedia/B\r\n\r\n";
        let (mut client, server) = serve_reply(payload).await;
        let body = read_framed_reply(&mut client).await.unwrap();
        assert_eq!(body, "200 OK\r\nmedia/A\r\nmedia/B\r\n\r\n");
        server.await.unwrap();
    }

    /// `201` replies carry exactly one data line after the status line.
    #[tokio::test]
    async fn read_framed_reply_201_reads_one_data_line() {
        let payload = b"201 INFO\r\n1 2 3\r\n";
        let (mut client, server) = serve_reply(payload).await;
        let body = read_framed_reply(&mut client).await.unwrap();
        assert_eq!(body, "201 INFO\r\n1 2 3\r\n");
        server.await.unwrap();
    }

    /// Error/status codes (4xx/5xx) also return immediately after the line.
    #[tokio::test]
    async fn read_framed_reply_error_codes_return_immediately() {
        let (mut client, server) = serve_reply(b"404 ERROR\r\n").await;
        let start = Instant::now();
        let body = read_framed_reply(&mut client).await.unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "404 reply stalled on the read gap"
        );
        assert_eq!(body, "404 ERROR\r\n");
        server.await.unwrap();
    }

    /// A peer that closes without sending a status line is a transport error,
    /// not an empty success.
    #[tokio::test]
    async fn read_framed_reply_closed_connection_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = sock.shutdown().await;
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        assert!(read_framed_reply(&mut client).await.is_err());
        server.await.unwrap();
    }

    /// Regression: CasparCG replies asynchronously AFTER the command executes
    /// (producer init can take ~1s), so the status line may arrive long after
    /// the 300 ms read-gap budget. The status-line wait must tolerate this —
    /// otherwise the client aborts, drops the connection, and the reply lands
    /// on `[destroyed-connection]` (the erratic connect/disconnect churn).
    #[tokio::test]
    async fn read_framed_reply_tolerates_slow_status_line() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Simulate CasparCG's async execution: the 202 ack only arrives
            // ~900 ms after the command was sent (producer initialization).
            tokio::time::sleep(Duration::from_millis(900)).await;
            let _ = sock.write_all(b"202 PLAY OK\r\n").await;
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        let start = Instant::now();
        let body = read_framed_reply(&mut client).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(body, "202 PLAY OK\r\n");
        assert!(
            elapsed >= Duration::from_millis(900),
            "status line returned before the delayed reply ({elapsed:?})"
        );
        server.await.unwrap();
    }

    #[test]
    fn parse_status_error() {
        let (code, status) = parse_status("404 ERROR\r\n");
        assert_eq!(code, 404);
        assert_eq!(status, AmcpStatus::Error);
    }

    #[test]
    fn parse_status_server() {
        let (code, status) = parse_status("501 INTERNAL\r\n");
        assert_eq!(code, 501);
        assert_eq!(status, AmcpStatus::Server);
    }

    #[test]
    fn escape_amcp_data_preserves_json_structure() {
        let json = serde_json::json!({ "text": "hello \"world\"" }).to_string();
        let escaped = escape_amcp_data(&json);
        // The outer quotes become \" so the token can be wrapped in "...".
        assert!(!escaped.contains("\"text\":\""));
        assert!(escaped.contains("\\\"text\\\""));
    }

    #[test]
    fn cg_add_cmd_format() {
        let cmd = cg_add_cmd(PROGRAM_CHANNEL, 33, 1, "playout/crawl", true, "{\"text\":\"hi\"}");
        assert_eq!(
            cmd,
            "CG 1-33 ADD 1 \"playout/crawl\" 1 \"{\\\"text\\\":\\\"hi\\\"}\""
        );
    }

    #[test]
    fn cg_update_cmd_format() {
        let cmd = cg_update_cmd(PROGRAM_CHANNEL, 33, 1, "{\"text\":\"hi\"}");
        assert_eq!(cmd, "CG 1-33 UPDATE 1 \"{\\\"text\\\":\\\"hi\\\"}\"");
    }

    /// What the template's `update()` receives: the AMCP tokenizer unescapes
    /// the token, the html producer builds `update("…")` escaping only `"`,
    /// and the JS engine unescapes that string literal. Returns `None` where
    /// the literal would end early (the SyntaxError seen live).
    fn caspar_html_update_arg(token: &str) -> Option<String> {
        let mut amcp = String::new();
        let mut chars = token.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                amcp.push(chars.next()?);
            } else {
                amcp.push(c);
            }
        }
        let literal = amcp.replace('"', "\\\"");
        let mut js = String::new();
        let mut chars = literal.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return None,
                '\\' => match chars.next()? {
                    'n' => js.push('\n'),
                    'r' => js.push('\r'),
                    't' => js.push('\t'),
                    'u' => {
                        let hex: String = chars.by_ref().take(4).collect();
                        js.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    }
                    other => js.push(other),
                },
                other => js.push(other),
            }
        }
        Some(js)
    }

    #[test]
    fn cg_data_reaches_the_html_template_unchanged() {
        let texts = [
            "Ακατάλληλο για παιδιά κάτω των 12 — \"Βία\" & <Γλώσσα>",
            "back\\slash, 'single', \"double\"",
            "line1\nline2\ttab\r",
            "\u{2028}\u{2029} </script> {json} [x]",
            "\\\"",
        ];
        for text in texts {
            let json = serde_json::json!({ "warning_text": text, "svg": "<svg viewBox=\"0 0 1 1\"/>" }).to_string();
            for cmd in [
                cg_update_cmd(PROGRAM_CHANNEL, 32, 1, &json),
                cg_add_cmd(PROGRAM_CHANNEL, 32, 1, "playout/advisory", true, &json),
            ] {
                let token = cmd.rsplit_once(" \"").map(|(_, t)| t.trim_end_matches('"')).unwrap();
                let received = caspar_html_update_arg(token);
                assert_eq!(received.as_deref(), Some(json.as_str()), "{:?} via {}", text, cmd);
            }
        }
        // The plain AMCP escaping alone breaks the literal at the first `\"`.
        let json = serde_json::json!({ "t": "a \"q\"" }).to_string();
        assert_eq!(caspar_html_update_arg(&escape_amcp_data(&json)), None);
    }

    #[test]
    fn play_image_cmd_format() {
        let cmd = play_image_cmd(PROGRAM_CHANNEL, 30, "logos/logo.png");
        assert_eq!(cmd, "PLAY 1-30 \"logos/logo.png\"");
    }

    #[test]
    fn clear_layer_cmd_format() {
        assert_eq!(clear_layer_cmd(PROGRAM_CHANNEL, 32), "CLEAR 1-32");
    }

    /// Crawl payload fuzz (plan §5): special characters that the old hand-rolled
    /// `escapeJson` corrupted. serde_json round-trips and the AMCP data token is
    /// a valid quoted shell token (inner quotes escaped, balanced wrapping).
    #[test]
    fn crawl_payload_fuzz_special_chars() {
        let tricky = vec![
            "hello \"world\"",
            "back\\slash",
            "line1\nline2",
            "tab\there",
            "emoji 🎬 and greek Καταλληλότητας",
            "mixed \" \n \\ \t end",
        ];

        for text in tricky {
            // Build the JSON payload the way CgPayload::crawl / caspar_cg_add does.
            let json = serde_json::json!({ "text": text }).to_string();

            // Round-trip: deserializing must yield the original text.
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed["text"].as_str().unwrap(), text, "round-trip failed for {:?}", text);

            // AMCP data token: inner quotes escaped, wrapped in "...".
            let escaped = escape_amcp_data(&json);
            let token = format!("\"{}\"", escaped);

            // The wrapping quotes are the first and last char; no unescaped inner
            // quote breaks the token (an unescaped " would only occur as the
            // wrapper boundary).
            assert!(token.starts_with('"') && token.ends_with('"'));
            // Every inner quote is escaped as \".
            let inner = &token[1..token.len() - 1];
            let chars = inner.chars().peekable();
            let mut unescaped_quotes = 0;
            let mut backslash_count = 0;
            for c in chars {
                if c == '\\' {
                    backslash_count += 1;
                } else if c == '"' {
                    if backslash_count % 2 == 0 {
                        unescaped_quotes += 1;
                    }
                    backslash_count = 0;
                } else {
                    backslash_count = 0;
                }
            }
            assert_eq!(unescaped_quotes, 0, "unescaped quote in AMCP token for {:?}", text);

            // The full ADD command is well-formed.
            let cmd = cg_add_cmd(PROGRAM_CHANNEL, 33, 1, "playout/crawl", true, &json);
            assert!(cmd.starts_with("CG 1-33 ADD 1 \"playout/crawl\" 1 \""));
        }
    }

    #[test]
    fn test_loadbg_cmd_formats() {
        assert_eq!(
            loadbg_cmd(1, 10, "media/clip", 0, 0, false),
            "LOADBG 1-10 \"media/clip\""
        );
        assert_eq!(
            loadbg_cmd(1, 10, "media/clip", 100, 250, false),
            "LOADBG 1-10 \"media/clip\" SEEK 100 LENGTH 150"
        );
        assert_eq!(
            loadbg_cmd(1, 10, "media/clip", 0, 0, true),
            "LOADBG 1-10 \"media/clip\" AUTO"
        );
        assert_eq!(
            loadbg_cmd(1, 10, "media/clip", 100, 250, true),
            "LOADBG 1-10 \"media/clip\" SEEK 100 LENGTH 150 AUTO"
        );
    }

    #[test]
    fn test_play_trimmed_cmd_formats() {
        assert_eq!(
            play_trimmed_cmd(1, 10, "media/clip", 0, 0),
            "PLAY 1-10 \"media/clip\""
        );
        assert_eq!(
            play_trimmed_cmd(1, 10, "media/clip", 100, 250),
            "PLAY 1-10 \"media/clip\" SEEK 100 LENGTH 150"
        );
    }

    #[test]
    fn test_monitor_mode_safe_commands() {
        assert!(is_safe_read_only_command("INFO"));
        assert!(is_safe_read_only_command("INFO 1"));
        assert!(is_safe_read_only_command("INFO 1-10"));
        assert!(is_safe_read_only_command("DIAG"));
        assert!(is_safe_read_only_command("VERSION"));
        assert!(is_safe_read_only_command("TLS"));
        assert!(is_safe_read_only_command("CINF \"test\""));
        assert!(is_safe_read_only_command("GL INFO"));
        assert!(is_safe_read_only_command("BYE"));
        assert!(is_safe_read_only_command("PING"));
    }

    #[test]
    fn test_monitor_mode_blocks_mutations() {
        assert!(!is_safe_read_only_command("PLAY 1-10 \"test\""));
        assert!(!is_safe_read_only_command("LOADBG 1-10 \"test\" AUTO"));
        assert!(!is_safe_read_only_command("PAUSE 1-10"));
        assert!(!is_safe_read_only_command("RESUME 1-10"));
        assert!(!is_safe_read_only_command("STOP 1-10"));
        assert!(!is_safe_read_only_command("CLEAR 1"));
        assert!(!is_safe_read_only_command("CG 1-32 ADD 1 \"template\" 1 \"{}\""));
        assert!(!is_safe_read_only_command("CG 1-32 CLEAR"));
        assert!(!is_safe_read_only_command("MIXER 1-10 FILL 0 0 1 1"));
    }

    /// Stale/degenerate IN points must never inject a SEEK. When IN >= OUT
    /// (e.g. a stale frontend IN that exceeds the real file), the command
    /// degrades to a clean PLAY so the clip starts from 0 instead of jumping
    /// into the middle. This is the manual-take jitter fix.
    #[test]
    fn test_play_trimmed_cmd_degenerate_trim_is_clean() {
        // IN >= OUT: no SEEK/LENGTH (would jump past the start)
        assert_eq!(
            play_trimmed_cmd(1, 10, "media/clip", 300, 250),
            "PLAY 1-10 \"media/clip\""
        );
        // IN == OUT: zero-length trim, clean PLAY
        assert_eq!(
            play_trimmed_cmd(1, 10, "media/clip", 250, 250),
            "PLAY 1-10 \"media/clip\""
        );
    }

    /// A start-trim (IN == 0, OUT < total) must still emit LENGTH so the
    /// producer stops at the OUT point — but without a redundant SEEK 0.
    #[test]
    fn test_play_trimmed_cmd_start_trim_emits_length_only() {
        assert_eq!(
            play_trimmed_cmd(1, 10, "media/clip", 0, 250),
            "PLAY 1-10 \"media/clip\" LENGTH 250"
        );
        // IN > 0 emits both SEEK and LENGTH
        assert_eq!(
            play_trimmed_cmd(1, 10, "media/clip", 100, 250),
            "PLAY 1-10 \"media/clip\" SEEK 100 LENGTH 150"
        );
    }
    // ── Audit T2-3 / T2-2 / T2-9 ─────────────────────────────────────────────

    #[test]
    fn validate_amcp_command_rejects_control_characters() {
        assert!(validate_amcp_command("PLAY 1-10 \"clip\"").is_ok());
        assert!(validate_amcp_command("PLAY 1-10 \"clip\"\r\n").is_ok(), "trailing CRLF is the frame terminator");
        assert!(validate_amcp_command("PLAY 1-10 \"a\r\nKILL\"").is_err());
        assert!(validate_amcp_command("PLAY 1-10 \"a\nKILL\"").is_err());
        assert!(validate_amcp_command("INFO\x00").is_err());
        assert!(validate_amcp_command("INFO\x7f").is_err());
        assert!(validate_amcp_command("").is_err());
        assert!(validate_amcp_command("   \r\n").is_err());
        // Non-ASCII printable text is not a control character.
        assert!(validate_amcp_command("CG 1-33 UPDATE 1 \"{\\\"t\\\":\\\"Καλησπέρα\\\"}\"").is_ok());
    }

    #[test]
    fn passthrough_allow_list() {
        for ok in ["PLAY 1-10 \"x\"", "loadbg 1-10 x AUTO", "CLEAR 1-20", "INFO 1-10", "CLS \"dir\"",
                   "REMOVE 1 DECKLINK 1", "ADD 1 DECKLINK 1", "PAUSE 1-10", "REQ abc INFO"] {
            assert!(is_allowed_passthrough_command(ok), "{}", ok);
        }
        for bad in ["KILL", "RESTART", "GL GC", "LOG LEVEL trace", "LOCK 1 ACQUIRE x", "SET 1 MODE 1080p5000",
                    "DATA STORE x y", "THUMBNAIL GENERATE_ALL", "DIAG", "BYE", "", "REQ abc", "REQ abc KILL"] {
            assert!(!is_allowed_passthrough_command(bad), "{}", bad);
        }
    }

    #[test]
    fn template_name_allow_list() {
        assert!(is_safe_template_name("playout/advisory"));
        assert!(is_safe_template_name("playout/crawl"));
        assert!(is_safe_template_name("my template-2.0"));
        assert!(!is_safe_template_name(""));
        assert!(!is_safe_template_name("../../etc"));
        assert!(!is_safe_template_name("adv\" 1 \"{}\"\r\nKILL"));
        assert!(!is_safe_template_name("adv\"isory"));
        assert!(!is_safe_template_name(r"adv\isory"));
    }

    /// CasparCG 2.x echoes the offending command on the line after `400 ERROR`.
    /// The echo must be consumed as part of this reply, not left in the socket
    /// to be mistaken for the next command's status line.
    #[tokio::test]
    async fn read_framed_reply_400_drains_echo_line() {
        let (mut client, server) = serve_reply(b"400 ERROR\r\nFOO 1-10\r\n").await;
        let body = read_framed_reply(&mut client).await.unwrap();
        assert_eq!(body, "400 ERROR\r\nFOO 1-10\r\n");
        server.await.unwrap();
    }

    /// A server that sends a bare `400 ERROR` still gets a complete reply
    /// (the drain is best-effort and bounded by the read-gap timeout).
    #[tokio::test]
    async fn read_framed_reply_400_without_echo_still_completes() {
        let (mut client, server) = serve_reply(b"400 ERROR\r\n").await;
        let body = read_framed_reply(&mut client).await.unwrap();
        assert_eq!(body, "400 ERROR\r\n");
        server.await.unwrap();
    }

    // ── PlayOut fork ──────────────────────────────────────────────────────

    const ROW: &str = "0b6c4f2e-8a1d-4e7b-9c3a-5d2f1e0a9be1";

    #[test]
    fn fork_verbs_pass_the_allow_list() {
        for good in [
            "QUEUE 1-10 INFO",
            "QUEUE 1-10 CLEAR AFTER a EXPECT b",
            "FALLBACK 1-10 \"playout/emergency\" LOOP TAG fallback STALL 50",
            "EVENTS 1-10 12",
            "ONAIR 1-10 abc CLEAR 1-31",
            "ONAIR 1-10 abc CG 1-32 UPDATE 1 \"{}\"",
            "REQ r1 ONAIR 1-10 abc MIXER 1-31 OPACITY 1",
        ] {
            assert!(is_allowed_passthrough_command(good), "{}", good);
        }
        for bad in [
            "ONAIR 1-10 abc KILL",
            "ONAIR 1-10 abc ONAIR 1-10 abc CLEAR 1-31",
            "ONAIR 1-10 abc QUEUE 1-10 CLEAR",
            "ONAIR 1-10 abc SWAP 1-10 1-20",
            "ONAIR 1-10 bad\"tag CLEAR 1-31",
            "ONAIR 1-10 abc",
        ] {
            assert!(!is_allowed_passthrough_command(bad), "{}", bad);
        }
    }

    #[test]
    fn read_only_mode_allows_fork_queries_only() {
        assert!(is_safe_read_only_command("QUEUE 1-10 INFO"));
        assert!(is_safe_read_only_command("EVENTS 1-10 4"));
        assert!(!is_safe_read_only_command("QUEUE 1-10 CLEAR"));
        assert!(!is_safe_read_only_command("QUEUE 1-10 \"INFO\" AUTO TAG x"));
        assert!(!is_safe_read_only_command("ONAIR 1-10 x CLEAR 1-31"));
    }

    #[test]
    fn tag_rule_mirrors_the_server() {
        assert!(is_valid_tag(ROW));
        assert!(is_valid_tag(&format!("{}:2", ROW)));
        assert!(is_valid_tag("a.b_c-d"));
        assert!(is_valid_tag(&"x".repeat(128)));
        assert!(!is_valid_tag(&"x".repeat(129)));
        assert!(!is_valid_tag(""));
        assert!(!is_valid_tag("has space"));
        assert!(!is_valid_tag("quote\""));
        assert!(!is_valid_tag("ελληνικά"));
    }

    #[test]
    fn with_tag_appends_tag_and_expect() {
        let play = play_trimmed_cmd(1, 10, "clips/a", 50, 150);
        assert_eq!(
            with_tag(play, Some("x"), None).unwrap(),
            "PLAY 1-10 \"clips/a\" SEEK 50 LENGTH 100 TAG x"
        );
        let loadbg = loadbg_cmd(1, 10, "clips/a", 0, 0, false);
        assert_eq!(
            with_tag(loadbg, Some("x"), Some("-")).unwrap(),
            "LOADBG 1-10 \"clips/a\" TAG x EXPECT -"
        );
        assert!(with_tag("PLAY 1-10".into(), Some("bad tag"), None).is_err());
        assert!(with_tag("PLAY 1-10".into(), None, Some("")).is_err());
    }

    #[test]
    fn tagged_item_cmd_builds_queue_loadbg_and_play() {
        let item = TaggedItem {
            path: "clips/b".into(),
            seek: Some(100),
            length: Some(500),
            auto: true,
            tag: "b".into(),
            expect: Some("a".into()),
        };
        assert_eq!(
            tagged_item_cmd(ItemVerb::Queue, 1, 10, &item).unwrap(),
            "QUEUE 1-10 \"clips/b\" SEEK 100 LENGTH 500 AUTO TAG b EXPECT a"
        );
        let take = TaggedItem { auto: false, expect: None, ..item.clone() };
        assert_eq!(
            tagged_item_cmd(ItemVerb::Loadbg, 1, 10, &take).unwrap(),
            "LOADBG 1-10 \"clips/b\" SEEK 100 LENGTH 500 TAG b"
        );
        // PLAY never carries AUTO.
        assert_eq!(
            tagged_item_cmd(ItemVerb::Play, 1, 10, &item).unwrap(),
            "PLAY 1-10 \"clips/b\" SEEK 100 LENGTH 500 TAG b EXPECT a"
        );
        // A zero SEEK is never sent.
        let head = TaggedItem { seek: Some(0), length: None, expect: None, ..item.clone() };
        assert_eq!(tagged_item_cmd(ItemVerb::Queue, 1, 10, &head).unwrap(), "QUEUE 1-10 \"clips/b\" AUTO TAG b");
        assert!(tagged_item_cmd(ItemVerb::Queue, 1, 10, &TaggedItem { tag: "".into(), ..item.clone() }).is_err());
        assert!(tagged_item_cmd(ItemVerb::Queue, 1, 10, &TaggedItem { path: "a\" KILL".into(), ..item }).is_err());
    }

    #[test]
    fn tagged_item_deserializes_from_the_frontend_shape() {
        let item: TaggedItem = serde_json::from_str(
            r#"{"path":"clips/b","seek":10,"length":null,"auto":true,"tag":"b","expect":"a"}"#,
        )
        .unwrap();
        assert_eq!(item.seek, Some(10));
        assert_eq!(item.length, None);
        assert_eq!(item.expect.as_deref(), Some("a"));
        let verb: ItemVerb = serde_json::from_str("\"loadbg\"").unwrap();
        assert_eq!(verb, ItemVerb::Loadbg);
    }

    #[test]
    fn queue_clear_and_remove_builders() {
        assert_eq!(queue_clear_cmd(1, 10, None, None).unwrap(), "QUEUE 1-10 CLEAR");
        assert_eq!(
            queue_clear_cmd(1, 10, Some("b"), Some("a")).unwrap(),
            "QUEUE 1-10 CLEAR AFTER b EXPECT a"
        );
        assert_eq!(queue_clear_cmd(1, 10, None, Some("a")).unwrap(), "QUEUE 1-10 CLEAR EXPECT a");
        assert!(queue_clear_cmd(1, 10, Some("b c"), None).is_err());
        assert_eq!(queue_remove_cmd(1, 10, "c", None).unwrap(), "QUEUE 1-10 REMOVE c");
        assert_eq!(
            queue_remove_cmd(1, 10, "c", Some("a")).unwrap(),
            "QUEUE 1-10 REMOVE c EXPECT a"
        );
        assert_eq!(queue_info_cmd(1, 10), "QUEUE 1-10 INFO");
    }

    #[test]
    fn onair_cmd_validates_its_inner_command() {
        assert_eq!(onair_cmd(1, 10, ROW, "CLEAR 1-31").unwrap(), format!("ONAIR 1-10 {} CLEAR 1-31", ROW));
        let update = cg_update_cmd(1, 32, 1, r#"{"text":"Ακατάλληλο \"17\""}"#);
        let onair = onair_cmd(1, 10, ROW, &update).unwrap();
        assert_eq!(onair, format!("ONAIR 1-10 {} {}", ROW, update));
        assert!(is_allowed_passthrough_command(&onair));
        assert!(onair_cmd(1, 10, ROW, "KILL").is_err());
        assert!(onair_cmd(1, 10, ROW, "QUEUE 1-10 CLEAR").is_err());
        assert!(onair_cmd(1, 10, ROW, "CLEAR 1-31\r\nKILL").is_err());
        assert!(onair_cmd(1, 10, "bad tag", "CLEAR 1-31").is_err());
    }

    #[test]
    fn fallback_and_events_builders() {
        assert_eq!(
            fallback_cmd(1, 10, "playout/emergency", true, "fallback", Some(50)).unwrap(),
            "FALLBACK 1-10 \"playout/emergency\" LOOP TAG fallback STALL 50"
        );
        assert_eq!(
            fallback_cmd(1, 10, "slate", false, "slate", None).unwrap(),
            "FALLBACK 1-10 \"slate\" TAG slate"
        );
        assert!(fallback_cmd(1, 10, "a\" KILL", true, "f", None).is_err());
        assert_eq!(fallback_clear_cmd(1, 10), "FALLBACK 1-10 CLEAR");
        assert_eq!(fallback_stall_cmd(1, 10, 0), "FALLBACK 1-10 STALL 0");
        assert_eq!(events_cmd(1, 10, None), "EVENTS 1-10");
        assert_eq!(events_cmd(1, 10, Some(14)), "EVENTS 1-10 14");
    }

    const QUEUE_INFO_REPLY: &str = concat!(
        "201 QUEUE INFO OK\r\n",
        r#"{"channel":1,"layer":10,"instance":1792065829887,"frame":553,"event_seq":14,"#,
        r#""foreground":{"tag":"a","producer":"ffmpeg","frame":5,"frames":50,"paused":false,"starting":false},"#,
        r#""waiting":[{"tag":"b","producer":"transition","auto":true},{"tag":"c","producer":"transition","auto":true}],"#,
        r#""fallback":{"set":true,"tag":"slate","active":false,"stall":50}}"#,
        "\r\n"
    );

    #[test]
    fn parses_queue_info_reply() {
        let info = parse_queue_info(QUEUE_INFO_REPLY).unwrap();
        assert_eq!(info.instance, 1792065829887);
        assert_eq!(info.event_seq, 14);
        let fg = info.foreground.as_ref().unwrap();
        assert_eq!((fg.tag.as_str(), fg.frame, fg.frames, fg.starting), ("a", 5, 50, false));
        let waiting: Vec<&str> = info.waiting.iter().map(|w| w.tag.as_str()).collect();
        assert_eq!(waiting, ["b", "c"]);
        assert!(info.fallback.set && !info.fallback.active);
        assert_eq!(info.fallback.stall, 50);

        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["eventSeq"], 14);
    }

    #[test]
    fn parses_queue_info_with_no_layer() {
        let body = concat!(
            "201 QUEUE INFO OK\r\n",
            r#"{"channel":1,"layer":10,"instance":7,"frame":0,"event_seq":0,"foreground":null,"waiting":[],"#,
            r#""fallback":{"set":false,"tag":"","active":false,"stall":0}}"#
        );
        let info = parse_queue_info(body).unwrap();
        assert!(info.foreground.is_none());
        assert!(info.waiting.is_empty());
    }

    #[test]
    fn stock_server_reply_is_not_fork_json() {
        assert!(parse_queue_info("400 ERROR\r\nQUEUE 1-10 INFO").is_err());
        assert!(parse_events("201 EVENTS OK\r\n").is_err());
    }

    #[test]
    fn parses_events_reply() {
        let body = concat!(
            "201 EVENTS OK\r\n",
            r#"{"channel":1,"layer":10,"instance":1792065829887,"frame":620,"last":9,"oldest":1,"events":["#,
            r#"{"seq":8,"frame":421,"time":1792066165620,"kind":"ended","tag":"c","reason":"ended"},"#,
            r#"{"seq":9,"frame":430,"time":1792066165980,"kind":"offair","tag":"c","reason":"clear"}]}"#,
            "\r\n"
        );
        let reply = parse_events(body).unwrap();
        assert_eq!(reply.last, 9);
        assert_eq!(reply.events.len(), 2);
        assert_eq!(reply.events[0].kind, "ended");
        assert_eq!(reply.events[1].reason, "clear");
        assert_eq!(reply.events[1].time, 1792066165980);
        assert!(!reply.lost_events_after(7));
        assert!(!reply.lost_events_after(0));

        let json = serde_json::to_value(&reply.events[0]).unwrap();
        assert_eq!(json["timeMs"], 1792066165620i64);
    }

    #[test]
    fn events_gap_detection() {
        let reply = EventsReply {
            channel: 1,
            layer: 10,
            instance: 1,
            frame: 0,
            last: 300,
            oldest: 173,
            events: vec![],
            lost: false,
        };
        assert!(reply.lost_events_after(100));
        assert!(!reply.lost_events_after(172));
    }

    #[test]
    fn parses_queue_clear_count() {
        assert_eq!(parse_queue_clear_count("201 QUEUE CLEAR OK\r\n2"), Some(2));
        assert_eq!(parse_queue_clear_count("409 QUEUE CLEAR CONFLICT"), None);
    }
}
