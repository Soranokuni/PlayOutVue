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
        }
    }

    /// Send a single AMCP command and await its framed reply.
    pub async fn send(&self, cmd: &str) -> Result<AmcpResponse, String> {
        let normalized = if cmd.ends_with("\r\n") {
            cmd.to_string()
        } else {
            format!("{}\r\n", cmd.trim_end())
        };

        loop {
            let (reply_tx, reply_rx) = oneshot::channel();
            let req = AmcpRequest {
                cmd: normalized.clone(),
                reply_tx,
            };

            let send_result = {
                let tx = self.worker.lock().await;
                tx.send(req).await
            };

            // If the channel is closed (worker died), respawn before retrying.
            if let Err(_send_err) = send_result {
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

/// Read a complete AMCP reply: accumulate bytes until `\r\n\r\n` (blank line)
/// terminates the frame, or the read-gap timeout fires, or the peer closes.
async fn read_framed_reply(stream: &mut TcpStream) -> Result<String, String> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 4096];

    loop {
        match timeout(READ_GAP_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                // Frame complete when we see the blank-line terminator.
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                // Many single-line replies (e.g. `202 CG OK\r\n`) end without a
                // trailing blank line; if the buffer is short and looks like a
                // complete status-only line ending in \r\n, accept it on a gap.
            }
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => break, // read-gap timeout: treat current buffer as complete
        }
    }

    Ok(String::from_utf8_lossy(&buf).to_string())
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

/// Build a `LOADBG <ch>-<layer> "path" SEEK X LENGTH Y AUTO` command.
/// If `in_frame` or `out_frame` are greater than 0, format it with ` SEEK [in_frame] LENGTH [out_frame - in_frame]`.
/// If `auto` is true, append ` AUTO`.
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
    if in_frame > 0 || out_frame > 0 {
        let length = out_frame.saturating_sub(in_frame);
        cmd.push_str(&format!(" SEEK {} LENGTH {}", in_frame, length));
    }
    if auto {
        cmd.push_str(" AUTO");
    }
    cmd
}

/// Build a `PLAY <ch>-<layer> "path" SEEK X LENGTH Y` command for trimmed files,
/// fallbacking to a simple `PLAY channel-layer "path"` if no trim is applied.
#[allow(dead_code)]
pub fn play_trimmed_cmd(
    channel: u8,
    layer: u16,
    path: &str,
    in_frame: u32,
    out_frame: u32,
) -> String {
    let mut cmd = format!("PLAY {}-{} \"{}\"", channel, layer, path);
    if in_frame > 0 || out_frame > 0 {
        let length = out_frame.saturating_sub(in_frame);
        cmd.push_str(&format!(" SEEK {} LENGTH {}", in_frame, length));
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caspar_layers::PROGRAM_CHANNEL;

    #[test]
    fn parse_status_ok() {
        let (code, status) = parse_status("202 CG OK\r\n");
        assert_eq!(code, 202);
        assert_eq!(status, AmcpStatus::Ok);
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
}