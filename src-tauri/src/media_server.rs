// Tiny async HTTP file server with Range request support.
// Started once at app boot; serves media files to the WebView's <video> element
// via http://127.0.0.1:<port>/?file=<url-encoded-path>
// Zero extra memory — files are streamed in 64 KB chunks directly from disk.

use std::sync::atomic::{AtomicU16, Ordering};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpListener;

static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

pub async fn start() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("[MediaServer] Failed to bind: {}", error))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("[MediaServer] Failed to get local address: {}", error))?
        .port();
    SERVER_PORT.store(port, Ordering::Relaxed);
    eprintln!("[MediaServer] Listening on 127.0.0.1:{}", port);

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => { tokio::spawn(handle(stream)); }
                Err(e) => eprintln!("[MediaServer] accept error: {}", e),
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
    format!("http://127.0.0.1:{}/?file={}", port, encoded)
}

// ── Connection handler ────────────────────────────────────────────────────────

async fn handle(mut stream: tokio::net::TcpStream) {
    // Read headers (up to 8 KB — enough for any HTTP/1.x request)
    let mut buf = vec![0u8; 8192];
    let n = match stream.read(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);

    // Only handle GET / HEAD
    let first = req.lines().next().unwrap_or("");
    let is_head = first.starts_with("HEAD ");
    if !first.starts_with("GET ") && !is_head {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n").await;
        return;
    }

    // OPTIONS pre-flight (CORS)
    if first.starts_with("OPTIONS ") {
        let resp = "HTTP/1.1 204 No Content\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, HEAD\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    // Extract ?file=<path>
    let url_path = first.split_whitespace().nth(1).unwrap_or("/");
    let file_path = if let Some(p) = url_path.find("?file=") {
        percent_decode(&url_path[p + 6..])
    } else {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    };

    // Normalise separators
    let file_path = std::path::PathBuf::from(file_path.replace('/', std::path::MAIN_SEPARATOR_STR));

    let meta = match std::fs::metadata(&file_path) {
        Ok(m) => m,
        Err(_) => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            return;
        }
    };
    let total = meta.len();

    // Parse Range header (e.g. "Range: bytes=0-1023")
    let range_hdr = req
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
        .map(|l| l[6..].trim().to_string());

    let (start, end) = if let Some(r) = range_hdr {
        let r = r.trim_start_matches("bytes=");
        let mut parts = r.splitn(2, '-');
        let s = parts.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
        let e = parts
            .next()
            .and_then(|p| p.parse::<u64>().ok())
            .unwrap_or(total.saturating_sub(1));
        (s, e.min(total.saturating_sub(1)))
    } else {
        (0, total.saturating_sub(1))
    };

    let content_len = end.saturating_sub(start) + 1;
    let is_partial  = start > 0 || end < total.saturating_sub(1);
    let status      = if is_partial { "206 Partial Content" } else { "200 OK" };

    let ext  = file_path.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_ascii_lowercase();
    let mime = mime_for(&ext);

    let headers = format!(
        "HTTP/1.1 {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Content-Range: bytes {}-{}/{}\r\n\
         Accept-Ranges: bytes\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n",
        status, mime, content_len, start, end, total
    );

    if let Err(_) = stream.write_all(headers.as_bytes()).await { return; }
    if is_head { return; } // HEAD → headers only

    // Stream the file
    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return,
    };
    if start > 0 {
        if let Err(_) = file.seek(std::io::SeekFrom::Start(start)).await { return; }
    }

    let mut remaining = content_len;
    let mut chunk = vec![0u8; 65536]; // 64 KB
    while remaining > 0 {
        let to_read = (remaining as usize).min(chunk.len());
        match file.read(&mut chunk[..to_read]).await {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&chunk[..n]).await.is_err() { break; }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
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
        "mxf"         => "application/mxf",
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
