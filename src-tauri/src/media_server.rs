// Tiny async HTTP file server with Range request support.
// Started once at app boot; serves media files to the WebView's <video> element
// via http://127.0.0.1:<port>/?file=<url-encoded-path>&t=<launch-token>
// Zero extra memory — files are streamed in 64 KB chunks directly from disk.
//
// Audit T2-1 / T2-22: the server is loopback-only, but any page in any browser
// on this machine could previously read any media/image file by guessing the
// port (wildcard CORS, absolute `?file=` path). Every request now has to carry
// the per-launch random token that only the Tauri frontend receives through
// `get_media_url`; there are no CORS headers at all (a same-machine `<video>`
// element does not need them, and a cross-origin `fetch` must fail).

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpListener;

static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Longest request head (request line + headers) we are willing to buffer.
const MAX_HEAD_BYTES: usize = 16 * 1024;

/// Per-launch random bearer token carried in the `t` query parameter.
fn media_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let bytes: [u8; 32] = rand::random();
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    })
}

/// Constant-time comparison of a presented token against the launch token.
pub fn token_matches(presented: &str, expected: &str) -> bool {
    if presented.len() != expected.len() || presented.is_empty() {
        return false;
    }
    presented
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub async fn start() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("[MediaServer] Failed to bind: {}", error))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("[MediaServer] Failed to get local address: {}", error))?
        .port();
    SERVER_PORT.store(port, Ordering::Relaxed);
    // Force token generation at startup so the first URL is not racing it.
    let _ = media_token();
    log::warn!("[MediaServer] Listening on 127.0.0.1:{}", port);

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => { tokio::spawn(handle(stream)); }
                Err(e) => log::warn!("[MediaServer] accept error: {}", e),
            }
        }
    });

    Ok(port)
}

pub fn url_for(path: &str) -> String {
    let port = SERVER_PORT.load(Ordering::Relaxed);
    if port == 0 {
        return String::new();
    }
    let encoded = percent_encode(path);
    format!("http://127.0.0.1:{}/?file={}&t={}", port, encoded, media_token())
}

// ── Connection handler ────────────────────────────────────────────────────────

async fn handle(mut stream: tokio::net::TcpStream) {
    // Read the request head until the blank line. A single `read` could split
    // the `Range:` header off the first chunk and silently serve the whole
    // file; loop until `\r\n\r\n` or the size cap.
    let mut head = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk)).await;
        let n = match read {
            Ok(Ok(n)) if n > 0 => n,
            _ => return,
        };
        head.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&head, b"\r\n\r\n") {
            break pos;
        }
        if head.len() > MAX_HEAD_BYTES {
            let _ = stream.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            return;
        }
    };
    let req = String::from_utf8_lossy(&head[..head_end]).into_owned();

    let first = req.lines().next().unwrap_or("");
    let mut request_line = first.split_whitespace();
    let method = request_line.next().unwrap_or("");
    let target = request_line.next().unwrap_or("/");
    let is_head = method == "HEAD";
    if method != "GET" && !is_head {
        // Includes OPTIONS: there is deliberately no CORS pre-flight support.
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        return;
    }

    let decision = match authorize_and_resolve(target, media_token()) {
        Ok(path) => path,
        Err(status) => {
            let _ = stream.write_all(status_only(status).as_bytes()).await;
            return;
        }
    };
    let file_path = decision;

    let meta = match tokio::fs::metadata(&file_path).await {
        Ok(m) if m.is_file() => m,
        _ => {
            let _ = stream.write_all(status_only(404).as_bytes()).await;
            return;
        }
    };
    let total = meta.len();

    let range_hdr = req
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
        .map(|l| l[6..].trim().to_string());

    let (start, end) = match range_hdr.as_deref().map(|r| parse_range(r, total)) {
        None => (0, total.saturating_sub(1)),
        Some(Some(bounds)) => bounds,
        Some(None) => {
            let resp = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                total
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            return;
        }
    };

    let content_len = if total == 0 { 0 } else { end - start + 1 };
    let is_partial  = range_hdr.is_some();
    let status      = if is_partial { "206 Partial Content" } else { "200 OK" };

    let ext  = file_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = mime_for(&ext);

    let content_range = if is_partial {
        format!("Content-Range: bytes {}-{}/{}\r\n", start, end, total)
    } else {
        String::new()
    };
    let headers = format!(
        "HTTP/1.1 {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         {}\
         Accept-Ranges: bytes\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n",
        status, mime, content_len, content_range
    );

    if (stream.write_all(headers.as_bytes()).await).is_err() { return; }
    if is_head || content_len == 0 { return; }

    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return,
    };
    if start > 0 && (file.seek(std::io::SeekFrom::Start(start)).await).is_err() {
        return;
    }

    let mut remaining = content_len;
    let mut buf = vec![0u8; 65536]; // 64 KB
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        match file.read(&mut buf[..to_read]).await {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).await.is_err() { break; }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
}

// ── Request validation (pure, unit-tested) ────────────────────────────────────

/// Extensions the server will ever hand out. Anything else is 403.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "mxf", "ts", "m2ts", "mpg", "mpeg", "webm", "flv", "m4v",
    "wav", "mp3", "aac", "flac", "ogg", "m4a", "aiff",
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "svg",
];

/// Validate the request target: token present and correct, `file` present,
/// no parent-directory components, extension allow-listed. Returns the HTTP
/// status to answer with on failure.
pub fn authorize_and_resolve(target: &str, expected_token: &str) -> Result<std::path::PathBuf, u16> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut file: Option<String> = None;
    let mut token: Option<String> = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "file" => file = Some(percent_decode(v)),
            "t" => token = Some(v.to_string()),
            _ => {}
        }
    }

    // Authenticate before revealing anything about the path.
    match token {
        Some(t) if token_matches(&t, expected_token) => {}
        _ => return Err(401),
    }

    let Some(file) = file else { return Err(400) };
    if file.trim().is_empty() {
        return Err(400);
    }

    let file_path = std::path::PathBuf::from(file.replace('/', std::path::MAIN_SEPARATOR_STR));
    if file_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(403);
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(403);
    }
    Ok(file_path)
}

/// Parse a `Range` header value against a file of `total` bytes. Supports
/// `bytes=a-b`, `bytes=a-` and the suffix form `bytes=-n`. Returns `None`
/// when the range is unsatisfiable (RFC 7233 → 416).
pub fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?.trim();
    if total == 0 {
        return None;
    }
    let last = total - 1;
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // Suffix range: last `n` bytes.
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        let start = total.saturating_sub(n);
        return Some((start, last));
    }
    let start: u64 = a.parse().ok()?;
    if start > last {
        return None;
    }
    let end: u64 = if b.is_empty() { last } else { b.parse().ok()? };
    if end < start {
        return None;
    }
    Some((start, end.min(last)))
}

fn status_only(status: u16) -> String {
    let text = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    format!("HTTP/1.1 {} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status, text)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "mkv"         => "video/x-matroska",
        "mov"         => "video/quicktime",
        "webm"        => "video/webm",
        "avi"         => "video/x-msvideo",
        "ts" | "m2ts" => "video/mp2t",
        "mpg" | "mpeg" => "video/mpeg",
        "flv"         => "video/x-flv",
        "mxf"         => "application/mxf",
        "wav"         => "audio/wav",
        "mp3"         => "audio/mpeg",
        "aac"         => "audio/aac",
        "flac"        => "audio/flac",
        "ogg"         => "audio/ogg",
        "m4a"         => "audio/mp4",
        "aiff"        => "audio/aiff",
        "png"         => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp"        => "image/webp",
        "gif"         => "image/gif",
        "bmp"         => "image/bmp",
        "svg"         => "image/svg+xml",
        _             => "application/octet-stream",
    }
}

fn percent_encode(s: &str) -> String {
    s.bytes().flat_map(|b| {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' |
            b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                vec![b as char]
            }
            _ => format!("%{:02X}", b).chars().collect(),
        }
    }).collect()
}

fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i+1..i+3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn rejects_missing_or_wrong_token_before_path_checks() {
        assert_eq!(authorize_and_resolve("/?file=C:/m/a.mp4", TOKEN).unwrap_err(), 401);
        assert_eq!(authorize_and_resolve("/?file=C:/m/a.mp4&t=nope", TOKEN).unwrap_err(), 401);
        // Even a traversal attempt is answered 401, not 403, without a token.
        assert_eq!(authorize_and_resolve("/?file=../x.mp4", TOKEN).unwrap_err(), 401);
        assert_eq!(authorize_and_resolve(&format!("/?file=C:/m/a.mp4&t={}", TOKEN.to_uppercase()), TOKEN).unwrap_err(), 401);
    }

    #[test]
    fn accepts_valid_token_and_media_path() {
        let p = authorize_and_resolve(&format!("/?file=C:/m/clip%20one.MP4&t={}", TOKEN), TOKEN).unwrap();
        assert!(p.to_string_lossy().ends_with("clip one.MP4"));
        // Parameter order is irrelevant.
        assert!(authorize_and_resolve(&format!("/?t={}&file=C:/m/a.png", TOKEN), TOKEN).is_ok());
    }

    #[test]
    fn rejects_traversal_and_unknown_extensions() {
        assert_eq!(authorize_and_resolve(&format!("/?file=C:/m/../secret.mp4&t={}", TOKEN), TOKEN).unwrap_err(), 403);
        assert_eq!(authorize_and_resolve(&format!("/?file=C:/Windows/system.ini&t={}", TOKEN), TOKEN).unwrap_err(), 403);
        assert_eq!(authorize_and_resolve(&format!("/?file=C:/m/casparcg.config&t={}", TOKEN), TOKEN).unwrap_err(), 403);
        assert_eq!(authorize_and_resolve(&format!("/?t={}", TOKEN), TOKEN).unwrap_err(), 400);
        assert_eq!(authorize_and_resolve(&format!("/?file=&t={}", TOKEN), TOKEN).unwrap_err(), 400);
    }

    #[test]
    fn url_for_carries_the_token() {
        SERVER_PORT.store(4242, Ordering::Relaxed);
        let url = url_for("C:/media/clip one.mp4");
        assert!(url.starts_with("http://127.0.0.1:4242/?file=C:/media/clip%20one.mp4&t="));
        let t = url.rsplit("&t=").next().unwrap();
        assert_eq!(t.len(), 64);
        assert!(authorize_and_resolve(&url["http://127.0.0.1:4242".len()..], media_token()).is_ok());
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)), "end clamped to file size");
        assert_eq!(parse_range("bytes=1000-", 1000), None, "start past EOF is 416");
        assert_eq!(parse_range("bytes=50-10", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=abc", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
    }

    #[test]
    fn token_compare_is_exact() {
        assert!(token_matches(TOKEN, TOKEN));
        assert!(!token_matches("", TOKEN));
        assert!(!token_matches(&TOKEN[..31], TOKEN));
        assert!(!token_matches(&format!("{}x", TOKEN), TOKEN));
    }
}
