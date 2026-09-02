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
/// - everything else (`202` ack, `4xx`, `5xx`): the status line alone.
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
        201 => {
            // Exactly one more line after the status line.
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
        escape_amcp_data(data)
    )
}

/// Build a `CG <ch>-<layer> UPDATE <index> "<data>"` command.
pub fn cg_update_cmd(channel: u8, layer: u16, index: u16, data: &str) -> String {
    format!(
        "CG {}-{} UPDATE {} \"{}\"",
        channel,
        layer,
        index,
        escape_amcp_data(data)
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
            let mut chars = inner.chars().peekable();
            let mut unescaped_quotes = 0;
            let mut backslash_count = 0;
            while let Some(c) = chars.next() {
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
}