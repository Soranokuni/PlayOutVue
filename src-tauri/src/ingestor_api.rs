use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State, Manager};

use crate::runtime_settings::{get_ingestor_api_base_url, get_ingestor_api_token};

const REQUEST_TIMEOUT_SECS: u64 = 5;
const HEARTBEAT_INTERVAL_SECS: u64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct V2QcFindingDto {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub measured: Option<String>,
    #[serde(default)]
    pub expected: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct V2QcReportDto {
    pub passed: bool,
    #[serde(default)]
    pub blocking_errors: usize,
    #[serde(default)]
    pub warnings_count: usize,
    #[serde(default)]
    pub findings: Vec<V2QcFindingDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct V2LoudnessDto {
    #[serde(default)]
    pub integrated_lufs: Option<f64>,
    #[serde(default)]
    pub true_peak_dbtp: Option<f64>,
    #[serde(default)]
    pub lra_lu: Option<f64>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct V2AssetDto {
    pub uuid: String,
    #[serde(default)]
    pub playoutvue_id: String,
    #[serde(default)]
    pub current_path: String,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub trim_in_ms: i64,
    #[serde(default)]
    pub trim_out_ms: i64,
    #[serde(default)]
    pub fps_num: i64,
    #[serde(default)]
    pub fps_den: i64,
    #[serde(default)]
    pub mezzanine_ok: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub virtual_folder: Option<String>,
    #[serde(default)]
    pub rating: Option<String>,
    #[serde(default)]
    pub tp: Option<String>,
    #[serde(default)]
    pub qc_report: Option<V2QcReportDto>,
    #[serde(default)]
    pub loudness: Option<V2LoudnessDto>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub original_virtual_folder: Option<String>,
    /// Frame geometry. The Ingestor's `/api/v2/assets*` routes serve the same
    /// row shape as V1, so these are present on the wire; dropping them made
    /// the inspector lose GOP/frame counts whenever V2 answered first.
    #[serde(default)]
    pub total_frames: Option<i64>,
    #[serde(default)]
    pub gop_frames: Option<i64>,
    #[serde(default)]
    pub keyframe_safe_start_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AssetResponse {
    pub uuid: String,
    pub current_path: String,
    pub duration_ms: i64,
    pub trim_in_ms: i64,
    pub trim_out_ms: i64,
    pub rating: String,
    pub tp: String,
    pub status: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub virtual_folder: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub original_virtual_folder: Option<String>,
    #[serde(default)]
    pub mezzanine_ok: Option<bool>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub fps_num: Option<i64>,
    #[serde(default)]
    pub fps_den: Option<i64>,
    #[serde(default)]
    pub total_frames: Option<i64>,
    #[serde(default)]
    pub gop_frames: Option<i64>,
    #[serde(default)]
    pub keyframe_safe_start_ms: Option<i64>,
    #[serde(default)]
    pub warnings: Option<Vec<String>>,
    #[serde(default)]
    pub playoutvue_id: Option<String>,
    #[serde(default)]
    pub qc_report: Option<V2QcReportDto>,
    #[serde(default)]
    pub loudness: Option<V2LoudnessDto>,
}

/// Centralized Strict Readiness Predicate.
/// An asset is considered playable only if it satisfies all 8 invariant requirements.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_strict_readiness(
    status: &str,
    mezzanine_ok: bool,
    current_path: &str,
    duration_ms: i64,
    trim_in_ms: i64,
    trim_out_ms: i64,
    fps_num: i64,
    fps_den: i64,
    blocking_errors: usize,
) -> (bool, Option<String>) {
    if status != "ready" && status != "completed" {
        return (false, Some(format!("Status '{}' is not ready", status)));
    }
    if !mezzanine_ok {
        return (false, Some("Mezzanine is not verified safe (mezzanine_ok = false)".into()));
    }
    if current_path.trim().is_empty() {
        return (false, Some("Asset current_path is empty".into()));
    }
    if current_path.contains(".tmp_") || current_path.starts_with(".tmp") {
        return (false, Some("Asset points to a transient/staging path (.tmp_)".into()));
    }
    if duration_ms <= 0 {
        return (false, Some("Duration must be > 0 ms".into()));
    }
    if trim_in_ms < 0 || trim_out_ms <= trim_in_ms || trim_out_ms > duration_ms {
        return (false, Some(format!("Invalid trim bounds: in={}, out={}, duration={}", trim_in_ms, trim_out_ms, duration_ms)));
    }
    if fps_num <= 0 || fps_den <= 0 {
        return (false, Some(format!("Invalid rational FPS: {}/{}", fps_num, fps_den)));
    }
    if blocking_errors > 0 {
        return (false, Some(format!("Asset has {} blocking QC findings", blocking_errors)));
    }
    (true, None)
}

/// Audit F-3: apply the strict readiness predicate to an `AssetResponse` that
/// came off the v1 single-asset endpoint or `POST /api/assets/batch`.
///
/// Those two endpoints are parsed as a raw `AssetResponse` and their `status`
/// was forwarded to the client untouched, while the library list goes through
/// `map_v2_to_asset_response` and downgrades `mezzanine_ok = false` to
/// `'error'`. The registry currently holds rows that are
/// `status = ready, mezzanine_ok = 0`, so the same asset showed **red in the
/// library and green in the rundown** and failed the sidecar QC check at TAKE.
/// One predicate now decides readiness for every path.
///
/// Unlike the v2 DTO, a v1 payload may legitimately omit `mezzanine_ok`,
/// `fps_num`/`fps_den` and `total_frames`. A field the server did not assert is
/// not treated as a failure: only fields that are present are judged. The
/// reason is appended to `warnings` so the operator can see why a row is red.
pub fn apply_strict_readiness(mut asset: AssetResponse) -> AssetResponse {
    // A v1 payload that does not carry a rational frame rate still has `fps`
    // often enough; derive one so the predicate has something to judge, and
    // pass the predicate's fps gate when neither is asserted.
    let (fps_num, fps_den) = match (asset.fps_num, asset.fps_den) {
        (Some(n), Some(d)) if n > 0 && d > 0 => (n, d),
        _ => match asset.fps {
            Some(f) if f > 0.0 => ((f * 1000.0).round() as i64, 1000),
            // Not asserted by this endpoint — do not fail the row on it.
            _ => (1, 1),
        },
    };

    // Same rule for the trim window: v1 rows sometimes carry trim_out_ms = 0
    // meaning "to the end of the file".
    let trim_out_ms = if asset.trim_out_ms <= 0 {
        asset.duration_ms
    } else {
        asset.trim_out_ms
    };

    let (is_playable, unready_reason) = evaluate_strict_readiness(
        &asset.status,
        asset.mezzanine_ok.unwrap_or(true),
        &asset.current_path,
        asset.duration_ms,
        asset.trim_in_ms,
        trim_out_ms,
        fps_num,
        fps_den,
        asset
            .qc_report
            .as_ref()
            .map(|qc| qc.blocking_errors)
            .unwrap_or(0),
    );

    if is_playable {
        asset.status = "ready".to_string();
        return asset;
    }

    let blocking = asset
        .qc_report
        .as_ref()
        .map(|qc| qc.blocking_errors)
        .unwrap_or(0);
    asset.status = if asset.status == "error"
        || asset.status == "failed"
        || asset.mezzanine_ok == Some(false)
        || blocking > 0
    {
        "error".to_string()
    } else if asset.status == "missing" {
        "missing".to_string()
    } else {
        "processing".to_string()
    };

    if let Some(reason) = unready_reason {
        let warnings = asset.warnings.get_or_insert_with(Vec::new);
        if !warnings.contains(&reason) {
            warnings.push(reason);
        }
    }

    asset
}

/// Maps a typed V2AssetDto into the standard hydrated AssetResponse
pub fn map_v2_to_asset_response(v2: V2AssetDto) -> AssetResponse {
    let blocking = v2.qc_report.as_ref().map(|qc| qc.blocking_errors).unwrap_or(0);
    let (is_playable, unready_reason) = evaluate_strict_readiness(
        &v2.status,
        v2.mezzanine_ok,
        &v2.current_path,
        v2.duration_ms,
        v2.trim_in_ms,
        v2.trim_out_ms,
        v2.fps_num,
        v2.fps_den,
        blocking,
    );

    let status = if is_playable {
        "ready".to_string()
    } else if v2.status == "error" || v2.status == "failed" || !v2.mezzanine_ok || blocking > 0 {
        "error".to_string()
    } else if v2.status == "missing" {
        // TRIM-CONTRACT-AUDIT C-4: the mezzanine is gone. Same order as
        // `apply_strict_readiness`, so the library and the rundown agree.
        "missing".to_string()
    } else {
        "processing".to_string()
    };

    let mut warnings = v2.warnings;
    if let Some(reason) = unready_reason {
        if !is_playable && !warnings.contains(&reason) {
            warnings.push(reason);
        }
    }

    let fps = if v2.fps_den > 0 {
        v2.fps_num as f64 / v2.fps_den as f64
    } else {
        25.0
    };

    AssetResponse {
        uuid: v2.uuid.clone(),
        current_path: v2.current_path,
        duration_ms: v2.duration_ms,
        trim_in_ms: v2.trim_in_ms,
        trim_out_ms: v2.trim_out_ms,
        rating: v2.rating.unwrap_or_else(|| "none".to_string()),
        tp: v2.tp.unwrap_or_else(|| "false".to_string()),
        status,
        display_name: v2.display_name,
        virtual_folder: v2.virtual_folder,
        deleted_at: v2.deleted_at,
        original_virtual_folder: v2.original_virtual_folder,
        mezzanine_ok: Some(v2.mezzanine_ok),
        fps: Some(fps),
        fps_num: Some(v2.fps_num),
        fps_den: Some(v2.fps_den),
        total_frames: v2.total_frames,
        gop_frames: v2.gop_frames,
        keyframe_safe_start_ms: v2.keyframe_safe_start_ms,
        warnings: Some(warnings),
        playoutvue_id: Some(if v2.playoutvue_id.is_empty() { v2.uuid } else { v2.playoutvue_id }),
        qc_report: v2.qc_report,
        loudness: v2.loudness,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HeartbeatEvent {
    pub online: bool,
    pub last_seen_at: u64,
    pub error: Option<String>,
    /// `true` while the most recent authenticated Ingestor call was answered
    /// 401. The health endpoint is exempt from the token, so the heartbeat
    /// alone cannot tell "reachable" from "reachable but rejecting us".
    #[serde(default)]
    pub auth_rejected: bool,
}

/// Audit T2-6: every asset id is interpolated into a URL path. Accept only a
/// canonical RFC 4122 textual UUID (`8-4-4-4-12` hex) so a value such as
/// `../folders/purge` can never rewrite the route. Case is preserved so the
/// Ingestor's own ids round-trip unchanged into response maps.
pub fn validate_uuid(uuid: &str) -> Result<String, String> {
    let trimmed = uuid.trim();
    let bytes = trimmed.as_bytes();
    let groups: [usize; 5] = [8, 4, 4, 4, 12];
    let mut idx = 0usize;
    let mut ok = bytes.len() == 36;
    for (g, len) in groups.iter().enumerate() {
        if !ok {
            break;
        }
        let end = idx + len;
        if end > bytes.len() || !bytes[idx..end].iter().all(|b| b.is_ascii_hexdigit()) {
            ok = false;
            break;
        }
        idx = end;
        if g < 4 {
            if idx >= bytes.len() || bytes[idx] != b'-' {
                ok = false;
                break;
            }
            idx += 1;
        }
    }
    if ok {
        Ok(trimmed.to_string())
    } else {
        Err(format!("Invalid Ingestor asset id '{}': expected a UUID", trimmed))
    }
}

/// Largest Ingestor response body we will buffer (asset lists with QC
/// reports are a few hundred KB; 16 MiB leaves ample headroom).
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Read a response body with a hard size cap so a misbehaving or spoofed
/// Ingestor cannot make the playout process allocate without bound.
async fn read_body_capped(response: reqwest::Response) -> Result<String, String> {
    note_auth_outcome(response.status(), response.url().path());
    if let Some(len) = response.content_length() {
        if len as usize > MAX_RESPONSE_BYTES {
            return Err(format!("Ingestor response too large ({} bytes)", len));
        }
    }
    let mut response = response;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read Ingestor response: {}", e))?
    {
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(format!("Ingestor response exceeded {} bytes", MAX_RESPONSE_BYTES));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// One shared HTTP client for the whole process (connection pooling, one TLS
/// config) instead of a new client and connector per Tauri command.
fn build_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {}", e))
        })
        .clone()
}

/// Host part (lower-case, without port) of an http(s) URL, or `None` when the
/// value is not an absolute http(s) URL.
fn url_host(url: &str) -> Option<String> {
    let lower = url.trim().to_ascii_lowercase();
    let rest = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next()?.to_string()
    } else {
        authority.split(':').next()?.to_string()
    };
    if host.is_empty() { None } else { Some(host) }
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "::1"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Audit T2-6: `api_base_url_override` arrives from the WebView on every
/// call. A compromised page could point the Rust client (and its purge/
/// rename calls) at an arbitrary host. The override is honoured only when
/// it targets loopback or the same host as the operator-configured base
/// URL; anything else is ignored with a log entry.
fn resolve_base_url(app_base_url: &str, override_url: &str) -> String {
    let configured = app_base_url.trim().trim_end_matches('/');
    let candidate = override_url.trim().trim_end_matches('/');
    if candidate.is_empty() {
        return configured.to_string();
    }
    let trusted = match url_host(candidate) {
        Some(host) => is_loopback_host(&host) || url_host(configured).as_deref() == Some(host.as_str()),
        None => false,
    };
    if trusted {
        candidate.to_string()
    } else {
        log::warn!(
            "[Ingestor] Ignoring untrusted api_base_url_override '{}' (configured base: '{}')",
            candidate, configured
        );
        configured.to_string()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// ── PlayoutTranscode 1.0.0 contract (2026-09-18 remediation) ─────────────────

/// Header carrying the operator-configured API token (`server.api_token`).
/// While the service has no token configured it ignores the header; once one
/// is set, every `/api/**` call except health answers 401 without it.
const API_TOKEN_HEADER: &str = "X-Api-Token";
/// Header that arms a destructive route. Without it those routes answer
/// `428 Precondition Required` and do nothing.
const CONFIRM_DESTRUCTIVE_HEADER: &str = "X-Confirm-Destructive";
const CONFIRM_DESTRUCTIVE_VALUE: &str = "yes";

/// Page size for `GET /api/assets`. Equal to the server default and well under
/// `MAX_RESPONSE_BYTES` now that listings omit `keyframe_offsets`.
const LIST_PAGE_SIZE: usize = 1000;
/// Hard stop on pages per listing so a server that keeps advertising a total
/// it never delivers cannot spin the client forever (100 x 1000 rows).
const LIST_MAX_PAGES: usize = 100;

/// Set when an authenticated route answered 401; cleared by the next success
/// on any non-exempt route. Surfaced to the operator through the heartbeat.
static AUTH_REJECTED: AtomicBool = AtomicBool::new(false);

pub fn auth_rejected() -> bool {
    AUTH_REJECTED.load(Ordering::Relaxed)
}

fn is_auth_exempt_path(path: &str) -> bool {
    path.ends_with("/api/health") || path.ends_with("/api/v2/health")
}

fn note_auth_outcome(status: reqwest::StatusCode, path: &str) {
    if is_auth_exempt_path(path) {
        return;
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        if !AUTH_REJECTED.swap(true, Ordering::Relaxed) {
            log::warn!("[Ingestor] API token rejected (HTTP 401) on '{}'", path);
        }
    } else if status.is_success() && AUTH_REJECTED.swap(false, Ordering::Relaxed) {
        log::info!("[Ingestor] API token accepted again on '{}'", path);
    }
}

fn apply_auth(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    let token = token.trim();
    if token.is_empty() {
        req
    } else {
        req.header(API_TOKEN_HEADER, token)
    }
}

fn apply_confirmation(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header(CONFIRM_DESTRUCTIVE_HEADER, CONFIRM_DESTRUCTIVE_VALUE)
}

/// Everything one command needs to talk to the Ingestor: the shared pooled
/// client, the resolved (trust-checked) base URL and the operator's token.
struct IngestorClient {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

impl IngestorClient {
    fn connect<R: Runtime>(app: &AppHandle<R>, override_url: Option<String>) -> Result<Self, String> {
        let base_url = resolve_base_url(
            &get_ingestor_api_base_url(app),
            &override_url.unwrap_or_default(),
        );
        Ok(Self {
            client: build_client()?,
            base_url,
            token: get_ingestor_api_token(app),
        })
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        apply_auth(self.client.request(method, url), &self.token)
    }

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::GET, url)
    }

    fn post(&self, url: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::POST, url)
    }

    fn put(&self, url: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::PUT, url)
    }

    /// A request to one of the Ingestor's gated routes (purge, folder trash,
    /// auto-purge): token plus the destructive-operation confirmation header.
    fn destructive(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        apply_confirmation(self.request(method, url))
    }
}

/// Short error code the Ingestor puts in `{"error": "..."}` bodies, or the
/// raw body (bounded) when it is not that shape.
fn error_code_from_body(body: &str) -> String {
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string());
    let mut code: String = code.chars().filter(|c| !c.is_control()).collect();
    if code.chars().count() > 200 {
        code = code.chars().take(200).collect::<String>() + "...";
    }
    code
}

/// Operator-facing wording for the error codes PlayoutTranscode returns
/// (remediation §8.3: bodies are short codes, not sentences).
fn describe_error_code(code: &str) -> String {
    match code {
        "" => "no details".to_string(),
        "unauthorized" => "API token missing or rejected".to_string(),
        "confirmation_required" => "destructive-operation confirmation header missing".to_string(),
        "invalid asset id" => "asset id is not a canonical UUID".to_string(),
        "asset not found" => "asset not found".to_string(),
        "asset not found in recycle bin" => "asset is not in the Recycle Bin".to_string(),
        "mezzanine_missing" => "the media file is gone from the mezzanine store".to_string(),
        "probe_unavailable" => {
            "could not read the media file - check that FFmpeg is installed on the ingest host".to_string()
        }
        "sidecar_write_failed" => "the sidecar could not be written on the ingest host".to_string(),
        "config_save_failed" => "the ingest service could not save its configuration".to_string(),
        "database error" => "ingest registry database error - check the service log".to_string(),
        "invalid tp" => "TP flag value rejected".to_string(),
        "invalid folder_path" | "invalid virtual_folder" | "invalid target_folder" => {
            "virtual folder path rejected (must start with '/', no empty, dotted, padded or trailing segments)".to_string()
        }
        other => other.to_string(),
    }
}

/// One user-visible message for a non-2xx Ingestor response. The raw code is
/// kept in the message so the diagnostics log stays searchable.
fn http_error(status: reqwest::StatusCode, url: &str, body: &str) -> String {
    let code = error_code_from_body(body);
    let detail = describe_error_code(&code);
    let n = status.as_u16();
    let lead = match n {
        401 => "Ingestor rejected the request (HTTP 401): API token missing or invalid. Set the token from `PlayoutTranscode gen-token` under Settings > PlayoutTranscode Ingestor API".to_string(),
        428 => "Ingestor refused a destructive operation (HTTP 428): confirmation header missing - this PlayOut build and the ingest service disagree on the protocol".to_string(),
        404 => format!("Ingestor: not found (HTTP 404): {}", detail),
        422 => format!("Ingestor rejected the request as invalid (HTTP 422): {}", detail),
        503 => format!("Ingestor service unavailable (HTTP 503): {}", detail),
        500..=599 => format!("Ingestor internal error (HTTP {}): {}", n, detail),
        _ => format!("Ingestor API returned HTTP {}: {}", n, detail),
    };
    format!("{} [{}]", lead, url)
}

/// Whether a listing must fetch another page (pure; see the unit tests).
///
/// * A pre-pagination service sends no `X-Total-Count`: the first response is
///   the whole library.
/// * With a total, keep going until we hold that many rows.
/// * Without a parseable total, a short page (below the limit the server
///   applied, or below our own page size) is the last one.
/// * An empty page or the page cap always stops the loop.
fn needs_next_page(
    has_total_header: bool,
    total: Option<usize>,
    applied_limit: Option<usize>,
    fetched: usize,
    page_len: usize,
    pages_fetched: usize,
) -> bool {
    if !has_total_header || page_len == 0 || pages_fetched >= LIST_MAX_PAGES {
        return false;
    }
    if let Some(limit) = applied_limit {
        if page_len < limit {
            return false;
        }
    }
    match total {
        Some(total) => fetched < total,
        None => page_len >= LIST_PAGE_SIZE,
    }
}

fn header_usize(headers: &reqwest::header::HeaderMap, name: &str) -> Option<usize> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<usize>().ok())
}

/// Why a paged listing did not produce assets.
enum ListError {
    /// Route absent, transport failure or unparseable body: try the next API
    /// generation.
    Fallback(String),
    /// The server answered and said no (non-404 HTTP error): stop.
    Fatal(String),
}

/// Fetch every page of a listing route (`/api/v2/assets` or `/api/assets`).
async fn list_all_pages(
    ingestor: &IngestorClient,
    path: &str,
    parse_page: fn(&str) -> Result<Vec<AssetResponse>, String>,
    diagnostics: &crate::diagnostics::DiagnosticState,
) -> Result<Vec<AssetResponse>, ListError> {
    let mut all: Vec<AssetResponse> = Vec::new();
    let mut offset = 0usize;
    let mut pages = 0usize;
    loop {
        let url = format!(
            "{}{}?limit={}&offset={}",
            ingestor.base_url, path, LIST_PAGE_SIZE, offset
        );
        let response = ingestor
            .get(&url)
            .send()
            .await
            .map_err(|e| ListError::Fallback(format!("Ingestor list request failed for '{}': {}", url, e)))?;
        let status = response.status();
        if status.as_u16() == 404 {
            return Err(ListError::Fallback(format!("Ingestor route '{}' not found", url)));
        }
        let has_total = response.headers().contains_key("x-total-count");
        let total = header_usize(response.headers(), "x-total-count");
        let applied_limit = header_usize(response.headers(), "x-limit");
        let body = read_body_capped(response)
            .await
            .map_err(|e| ListError::Fatal(format!("Failed to read Ingestor list response for '{}': {}", url, e)))?;
        if !status.is_success() {
            return Err(ListError::Fatal(http_error(status, &url, &body)));
        }
        let page = parse_page(&body).map_err(|e| {
            ListError::Fallback(format!("Failed to parse Ingestor list response for '{}': {}", url, e))
        })?;
        let page_len = page.len();
        pages += 1;
        all.extend(page);
        if !needs_next_page(has_total, total, applied_limit, all.len(), page_len, pages) {
            if has_total && page_len > 0 && total.map(|t| all.len() < t).unwrap_or(false) {
                diagnostics.push(
                    "warn",
                    "ingestor",
                    format!(
                        "Listing stopped after {} pages with {} of {} rows from '{}'",
                        pages, all.len(), total.unwrap_or(0), path
                    ),
                );
            }
            break;
        }
        offset += page_len;
    }
    if pages > 1 {
        diagnostics.push(
            "info",
            "ingestor",
            format!("Listed {} assets from '{}' across {} pages", all.len(), path, pages),
        );
    }
    Ok(all)
}

fn parse_v2_page(body: &str) -> Result<Vec<AssetResponse>, String> {
    serde_json::from_str::<Vec<V2AssetDto>>(body)
        .map(|rows| rows.into_iter().map(map_v2_to_asset_response).collect())
        .map_err(|e| e.to_string())
}

fn parse_v1_page(body: &str) -> Result<Vec<AssetResponse>, String> {
    serde_json::from_str::<Vec<AssetResponse>>(body).map_err(|e| e.to_string())
}

/// Mirror of the Ingestor's `is_valid_virtual_folder`, so an operator gets a
/// precise message instead of a bare 422. Accepts `/` and `/A/B` forms only.
pub fn is_valid_virtual_folder(path: &str) -> bool {
    if path.is_empty() || !path.starts_with('/') || path.len() > 512 {
        return false;
    }
    if path == "/" {
        return true;
    }
    if path.ends_with('/') {
        return false;
    }
    path[1..].split('/').all(|segment| {
        !segment.is_empty()
            && segment == segment.trim()
            && segment != "."
            && segment != ".."
            && !segment.chars().any(|c| c.is_control())
    })
}

fn validate_virtual_folder(path: &str, what: &str) -> Result<(), String> {
    if is_valid_virtual_folder(path) {
        Ok(())
    } else {
        Err(format!(
            "Invalid {} '{}': must start with '/' and contain no empty, '.', '..', padded or trailing segments",
            what, path
        ))
    }
}

const NAMED_FOLDER_COLORS: &[&str] = &[
    "default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "grey", "gray",
];

/// Mirror of the Ingestor's folder-colour allow-list (`#rrggbb` or a name;
/// empty clears).
pub fn is_valid_folder_color(color: &str) -> bool {
    if color.is_empty() {
        return true;
    }
    if let Some(hex) = color.strip_prefix('#') {
        return hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    NAMED_FOLDER_COLORS.contains(&color.to_ascii_lowercase().as_str())
}

const MAX_DISPLAY_NAME_LEN: usize = 255;

/// Mirror of the Ingestor's display-name rule: trimmed, 1..=255 bytes, no
/// control characters. Returns the trimmed name.
fn validate_display_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Display name must not be empty".to_string());
    }
    if trimmed.len() > MAX_DISPLAY_NAME_LEN {
        return Err(format!("Display name exceeds {} bytes", MAX_DISPLAY_NAME_LEN));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("Display name must not contain control characters".to_string());
    }
    Ok(trimmed.to_string())
}

/// What a purge actually did (remediation §8.2). Purging a non-`ready` row
/// removes the registry entry but keeps the file, so "media removed" must be
/// read from here rather than inferred from the row disappearing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PurgeOutcome {
    #[serde(default)]
    pub operation: String,
    #[serde(default)]
    pub rows_deleted: u64,
    #[serde(default)]
    pub media_removed: bool,
    #[serde(default)]
    pub sidecar_removed: bool,
    #[serde(default)]
    pub skipped_referenced_files: Vec<String>,
    #[serde(default)]
    pub cleanup_failures: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Lenient: an older service answers purge with an empty or ad-hoc body.
fn parse_purge_outcome(body: &str) -> PurgeOutcome {
    serde_json::from_str::<PurgeOutcome>(body).unwrap_or_default()
}

#[tauri::command]
pub async fn check_ingestor_health<R: Runtime>(
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<bool, String> {
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    // 1. Try V2 health route first
    let v2_url = format!("{}/api/v2/health", base_url);
    diagnostics.push("info", "ingestor", format!("Checking Ingestor API V2 health at '{}'", v2_url));
    let v2_res = ingestor.get(&v2_url).send().await;

    if let Ok(ref resp) = v2_res {
        if resp.status().is_success() {
            let elapsed = start_time.elapsed().as_millis();
            diagnostics.push("info", "ingestor", format!("Ingestor V2 health check succeeded in {}ms", elapsed));
            return Ok(true);
        }
    }

    // 2. Fallback to V1 health route
    let v1_url = format!("{}/api/health", base_url);
    diagnostics.push("info", "ingestor", format!("Falling back to Ingestor API V1 health at '{}'", v1_url));
    let res = match ingestor.get(&v1_url).send().await {
        Ok(response) => Ok(response.status().is_success()),
        Err(error) => Err(format!("Ingestor health check failed for '{}': {}", v1_url, error)),
    };

    let elapsed = start_time.elapsed().as_millis();
    match &res {
        Ok(ok) => diagnostics.push("info", "ingestor", format!("Ingestor API health check returned {} in {}ms", ok, elapsed)),
        Err(err) => diagnostics.push("error", "ingestor", format!("Ingestor API health check failed in {}ms: {}", elapsed, err)),
    }
    res
}

#[tauri::command]
pub async fn list_ingestor_assets<R: Runtime>(
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<Vec<AssetResponse>, String> {
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;

    // Both generations of the listing route are paged (remediation §4):
    // `limit` defaults to 1000, so a single unpaged request silently truncates
    // a library past that size. `list_all_pages` walks `X-Total-Count`.

    // 1. Primary: V2 listing. Route missing, transport failure or an
    //    unparseable body falls through to V1; any other HTTP error is final.
    diagnostics.push(
        "info",
        "ingestor",
        format!("Listing Ingestor assets from V2 API at '{}/api/v2/assets'", ingestor.base_url),
    );
    match list_all_pages(&ingestor, "/api/v2/assets", parse_v2_page, &diagnostics).await {
        Ok(assets) => {
            diagnostics.push(
                "info",
                "ingestor",
                format!("Hydrated {} assets via V2 API in {}ms", assets.len(), start_time.elapsed().as_millis()),
            );
            return Ok(assets);
        }
        Err(ListError::Fatal(err)) => {
            diagnostics.push("error", "ingestor", err.clone());
            return Err(err);
        }
        Err(ListError::Fallback(reason)) => {
            diagnostics.push(
                "info",
                "ingestor",
                format!("V2 listing unavailable ({}); falling back to Ingestor V1 API", reason),
            );
        }
    }

    // 2. Fallback: V1 listing.
    match list_all_pages(&ingestor, "/api/assets", parse_v1_page, &diagnostics).await {
        Ok(assets) => {
            diagnostics.push(
                "info",
                "ingestor",
                format!("Listed {} assets from Ingestor V1 API in {}ms", assets.len(), start_time.elapsed().as_millis()),
            );
            Ok(assets)
        }
        Err(ListError::Fatal(err)) | Err(ListError::Fallback(err)) => {
            diagnostics.push("error", "ingestor", err.clone());
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn resolve_ingestor_asset<R: Runtime>(
    uuid: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<AssetResponse, String> {
    let uuid = validate_uuid(&uuid)?;
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    // 1. Primary: query V2 single asset endpoint
    let v2_url = format!("{}/api/v2/assets/{}", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Resolving Ingestor asset '{}' from V2 API at '{}'", uuid, v2_url));

    let v2_res = ingestor.get(&v2_url).send().await;
    if let Ok(response) = v2_res {
        let status = response.status();
        if status.is_success() {
            let body = read_body_capped(response).await.map_err(|e| {
                format!("Failed to read Ingestor V2 asset response: {}", e)
            })?;
            if let Ok(v2_asset) = serde_json::from_str::<V2AssetDto>(&body) {
                let mapped = map_v2_to_asset_response(v2_asset);
                let elapsed = start_time.elapsed().as_millis();
                diagnostics.push("info", "ingestor", format!("Resolved asset '{}' via V2 API in {}ms", uuid, elapsed));
                return Ok(mapped);
            }
        } else if status.as_u16() != 404 {
            let body = read_body_capped(response).await.unwrap_or_default();
            let err = http_error(status, &v2_url, &body);
            diagnostics.push("error", "ingestor", err.clone());
            return Err(err);
        }
    }

    // 2. Fallback: query V1 single asset endpoint
    let url = format!("{}/api/assets/{}", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Falling back to Ingestor V1 asset resolution at '{}'", url));

    let response_res = ingestor.get(&url).send().await;
    let elapsed_req = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Ingestor API request failed for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed_req));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.map_err(|e| {
        let err = format!("Failed to read Ingestor API response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", err.clone());
        return Err(err);
    }

    let parsed = serde_json::from_str::<AssetResponse>(&body).map_err(|e| {
        let err = format!(
            "Failed to parse Ingestor API response for '{}': {}. Body: {}",
            url, e, body
        );
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;
    // Audit F-3: one readiness predicate for v2, v1 and the batch.
    let parsed = apply_strict_readiness(parsed);

    let total_elapsed = start_time.elapsed().as_millis();
    diagnostics.push(
        "info",
        "ingestor",
        format!(
            "Resolved asset '{}' from Ingestor V1 API in {}ms (HTTP request took {}ms)",
            uuid, total_elapsed, elapsed_req
        ),
    );
    Ok(parsed)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn update_ingestor_trim<R: Runtime>(
    uuid: String,
    trim_in_ms: i64,
    trim_out_ms: i64,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let uuid = validate_uuid(&uuid)?;

    let start_time = std::time::Instant::now();
    if trim_in_ms < 0 || trim_out_ms < 0 {
        return Err("Trim values must be non-negative".to_string());
    }

    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/trim", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Updating Ingestor asset '{}' trim (in: {}, out: {}) at '{}'", uuid, trim_in_ms, trim_out_ms, url));

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct TrimPayload {
        trim_in_ms: i64,
        trim_out_ms: i64,
    }

    let response_res = ingestor
        .put(&url)
        .json(&TrimPayload {
            trim_in_ms,
            trim_out_ms,
        })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to update trim via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully updated trim for asset '{}' in {}ms", uuid, elapsed));
    Ok(())
}

/// Uppercase only the age token of a rating value.
///
/// The rating column holds `age|TP or NONE|CONTENT TYPE|[advisory timeline JSON]`.
/// Everything after the first `|` is passed through untouched so JSON keys
/// and Greek advisory text survive the round trip (client guide §7.2.1). A bare
/// age token (no `|`) is uppercased as before.
fn normalize_rating_value(rating: &str) -> String {
    let trimmed = rating.trim();
    match trimmed.split_once('|') {
        Some((age, tail)) => format!("{}|{}", age.trim().to_ascii_uppercase(), tail),
        None => trimmed.to_ascii_uppercase(),
    }
}

#[tauri::command]
pub async fn update_ingestor_rating<R: Runtime>(
    uuid: String,
    rating: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let uuid = validate_uuid(&uuid)?;
    let start_time = std::time::Instant::now();
    let final_rating = normalize_rating_value(&rating);

    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/rating", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Updating Ingestor asset '{}' rating to '{}' at '{}'", uuid, final_rating, url));

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct RatingPayload {
        rating: String,
    }

    let response_res = ingestor
        .put(&url)
        .json(&RatingPayload { rating: final_rating.clone() })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to update rating via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully updated rating to '{}' for asset '{}' in {}ms", final_rating, uuid, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn resolve_ingestor_assets_batch<R: Runtime>(
    uuids: Vec<String>,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<std::collections::HashMap<String, AssetResponse>, String> {
    let start_time = std::time::Instant::now();
    if uuids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let uuids = uuids
        .iter()
        .map(|u| validate_uuid(u))
        .collect::<Result<Vec<String>, String>>()?;

    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/batch", base_url);
    diagnostics.push("info", "ingestor", format!("Resolving batch of {} assets at '{}'", uuids.len(), url));


    let response_res = ingestor
        .post(&url)
        .timeout(Duration::from_secs(10))
        .json(&uuids)
        .send()
        .await;

    let elapsed_req = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Ingestor batch API request failed for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed_req));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.map_err(|e| {
        let err = format!("Failed to read Ingestor batch API response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", err.clone());
        return Err(err);
    }

    let map: std::collections::HashMap<String, AssetResponse> =
        serde_json::from_str(&body).map_err(|e| {
            let err = format!(
                "Failed to parse Ingestor batch API response for '{}': {}. Body: {}",
                url, e, body
            );
            diagnostics.push("error", "ingestor", err.clone());
            err
        })?;

    // Audit F-3: the batch bypassed the strict readiness predicate that the
    // library list goes through, so a `ready / mezzanine_ok = false` row came
    // back green in the rundown and red in the library.
    let map: std::collections::HashMap<String, AssetResponse> = map
        .into_iter()
        .map(|(k, v)| (k, apply_strict_readiness(v)))
        .collect();

    let total_elapsed = start_time.elapsed().as_millis();
    diagnostics.push(
        "info",
        "ingestor",
        format!(
            "Successfully resolved batch of {} assets in {}ms (HTTP request took {}ms)",
            map.len(),
            total_elapsed,
            elapsed_req
        ),
    );
    Ok(map)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn move_ingestor_asset<R: Runtime>(
    uuid: String,
    virtual_folder: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let uuid = validate_uuid(&uuid)?;
    validate_virtual_folder(&virtual_folder, "virtual_folder")?;

    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/move", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Moving Ingestor asset '{}' to virtual folder '{}' at '{}'", uuid, virtual_folder, url));

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct MovePayload {
        virtual_folder: String,
    }

    let response_res = ingestor
        .put(&url)
        .json(&MovePayload { virtual_folder: virtual_folder.clone() })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to move asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_default();

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully moved asset '{}' to '{}' in {}ms", uuid, virtual_folder, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn rename_ingestor_asset<R: Runtime>(
    uuid: String,
    display_name: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let uuid = validate_uuid(&uuid)?;
    let display_name = validate_display_name(&display_name)?;
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/rename", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Renaming Ingestor asset '{}' to '{}' at '{}'", uuid, display_name, url));

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct RenamePayload {
        display_name: String,
    }

    let response_res = ingestor
        .put(&url)
        .json(&RenamePayload { display_name: display_name.clone() })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to rename asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_default();

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully renamed asset '{}' to '{}' in {}ms", uuid, display_name, elapsed));
    Ok(())
}

pub fn spawn_ingestor_heartbeat<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let start = std::time::Instant::now();
            // `/api/health` is exempt from the token, so this only proves the
            // service is reachable; `auth_rejected` carries whether our
            // authenticated calls are currently being accepted.
            let (online, error) = match IngestorClient::connect(&app, None) {
                Ok(ingestor) => {
                    let url = format!("{}/api/health", ingestor.base_url);
                    match ingestor.get(&url).send().await {
                        Ok(response) => {
                            if response.status().is_success() {
                                (true, None)
                            } else {
                                (
                                    false,
                                    Some(format!("HTTP {}", response.status().as_u16())),
                                )
                            }
                        }
                        Err(error) => (false, Some(format!("{}", error))),
                    }
                }
                Err(error) => (false, Some(error)),
            };

            let elapsed = start.elapsed().as_millis();
            let auth_rejected = auth_rejected();

            // Log heartbeat latency to diagnostics if enabled
            if let Some(diagnostics) = app.try_state::<crate::diagnostics::DiagnosticState>() {
                if diagnostics.is_enabled() {
                    if online {
                        diagnostics.push(
                            "info",
                            "ingestor",
                            format!("Heartbeat checked in {}ms. Online: true. Auth rejected: {}", elapsed, auth_rejected),
                        );
                    } else {
                        diagnostics.push("warn", "ingestor", format!("Heartbeat failed in {}ms. Offline. Error: {:?}", elapsed, error));
                    }
                }
            }

            let payload = HeartbeatEvent {
                online,
                last_seen_at: now_ms(),
                error,
                auth_rejected,
            };

            let _ = app.emit("ingestor-heartbeat", payload);
            tokio::time::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_SECS)).await;
        }
    });
}

#[tauri::command(rename_all = "snake_case")]
pub async fn create_ingestor_subclip<R: Runtime>(
    uuid: String,
    display_name: String,
    trim_in_ms: i64,
    trim_out_ms: i64,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<AssetResponse, String> {
    let uuid = validate_uuid(&uuid)?;
    let start_time = std::time::Instant::now();
    if trim_in_ms < 0 || trim_out_ms < 0 {
        return Err("Trim values must be non-negative".to_string());
    }
    let display_name = validate_display_name(&display_name)?;

    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/subclip", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Creating subclip from asset '{}' at '{}'", uuid, url));

    #[derive(Serialize)]
    struct SubclipPayload {
        display_name: String,
        trim_in_ms: i64,
        trim_out_ms: i64,
    }

    let response_res = ingestor
        .post(&url)
        .json(&SubclipPayload {
            display_name,
            trim_in_ms,
            trim_out_ms,
        })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to create subclip via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.map_err(|e| {
        let err = format!("Failed to read subclip response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", err.clone());
        return Err(err);
    }

    let parsed = serde_json::from_str::<AssetResponse>(&body).map_err(|e| {
        let err = format!(
            "Failed to parse subclip API response: {}. Body: {}",
            e, body
        );
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;
    let parsed = apply_strict_readiness(parsed);

    diagnostics.push("info", "ingestor", format!("Successfully created subclip in {}ms", elapsed));
    Ok(parsed)
}

#[tauri::command]
pub async fn update_ingestor_tp<R: Runtime>(
    uuid: String,
    tp: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let uuid = validate_uuid(&uuid)?;
    let start_time = std::time::Instant::now();
    let upper = tp.to_ascii_uppercase();

    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/tp", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Updating Ingestor asset '{}' tp to '{}' at '{}'", uuid, upper, url));

    #[derive(Serialize)]
    struct TpPayload {
        tp: String,
    }

    let response_res = ingestor
        .put(&url)
        .json(&TpPayload { tp: upper.clone() })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to update tp via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully updated tp for asset '{}' in {}ms", uuid, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn purge_ingestor_asset<R: Runtime>(
    uuid: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<PurgeOutcome, String> {
    let uuid = validate_uuid(&uuid)?;
    let start_time = std::time::Instant::now();

    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();

    let url = format!("{}/api/assets/{}/purge", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Purging Ingestor asset '{}' at '{}'", uuid, url));

    let response_res = ingestor
        .destructive(reqwest::Method::DELETE, &url)
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to purge asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully purged asset '{}' in {}ms", uuid, elapsed));
    Ok(parse_purge_outcome(&body))
}

#[tauri::command]
pub async fn trash_ingestor_asset<R: Runtime>(
    uuid: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let uuid = validate_uuid(&uuid)?;
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/assets/{}/trash", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Moving Ingestor asset '{}' to Recycle Bin at '{}'", uuid, url));
    let response_res = ingestor.post(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to trash asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully moved asset '{}' to Recycle Bin in {}ms", uuid, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn trash_ingestor_folder<R: Runtime>(
    folder_path: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    validate_virtual_folder(&folder_path, "folder_path")?;
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/folders/trash", base_url);
    diagnostics.push("info", "ingestor", format!("Moving Ingestor folder '{}' to Recycle Bin at '{}'", folder_path, url));
    #[derive(Serialize)]
    struct TrashFolderPayload {
        folder_path: String,
    }
    let response_res = ingestor.destructive(reqwest::Method::POST, &url).json(&TrashFolderPayload { folder_path: folder_path.clone() }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to trash folder via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully moved folder '{}' to Recycle Bin in {}ms", folder_path, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn restore_ingestor_asset<R: Runtime>(
    uuid: String,
    target_folder: Option<String>,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<Option<AssetResponse>, String> {
    let uuid = validate_uuid(&uuid)?;
    if let Some(target) = target_folder.as_deref() {
        validate_virtual_folder(target, "target_folder")?;
    }
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/assets/{}/restore", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Restoring Ingestor asset '{}' from Recycle Bin at '{}'", uuid, url));
    #[derive(Serialize)]
    struct RestoreAssetPayload {
        target_folder: Option<String>,
    }
    let response_res = ingestor.post(&url).json(&RestoreAssetPayload { target_folder }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to restore asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully restored asset '{}' in {}ms", uuid, elapsed));

    #[derive(Deserialize)]
    struct RestoreAssetResponseWrapper {
        #[serde(default)]
        asset: Option<AssetResponse>,
    }

    let parsed_asset = if let Ok(wrapper) = serde_json::from_str::<RestoreAssetResponseWrapper>(&body) {
        wrapper.asset
    } else {
        serde_json::from_str::<AssetResponse>(&body).ok()
    };

    Ok(parsed_asset)
}

#[tauri::command]
pub async fn restore_ingestor_folder<R: Runtime>(
    folder_path: String,
    fallback_to_root: Option<bool>,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    validate_virtual_folder(&folder_path, "folder_path")?;
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/folders/restore", base_url);
    diagnostics.push("info", "ingestor", format!("Restoring Ingestor folder '{}' from Recycle Bin at '{}'", folder_path, url));
    #[derive(Serialize)]
    struct RestoreFolderPayload {
        folder_path: String,
        fallback_to_root: Option<bool>,
    }
    let response_res = ingestor.post(&url).json(&RestoreFolderPayload { folder_path: folder_path.clone(), fallback_to_root }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to restore folder via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully restored folder '{}' in {}ms", folder_path, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn list_ingestor_recycle_bin<R: Runtime>(
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<Vec<AssetResponse>, String> {
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/recycle-bin", base_url);
    let response_res = ingestor.get(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to fetch recycle bin via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    let parsed: Vec<AssetResponse> = serde_json::from_str(&body).map_err(|e| {
        let err = format!("Failed to parse recycle bin response from '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    Ok(parsed)
}

#[tauri::command]
pub async fn purge_ingestor_recycle_bin<R: Runtime>(
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<PurgeOutcome, String> {
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/recycle-bin/purge", base_url);
    diagnostics.push("info", "ingestor", format!("Emptying Ingestor Recycle Bin at '{}'", url));
    let response_res = ingestor.destructive(reqwest::Method::DELETE, &url).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to empty recycle bin via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully emptied Recycle Bin in {}ms", elapsed));
    Ok(parse_purge_outcome(&body))
}

#[tauri::command]
pub async fn purge_ingestor_folder<R: Runtime>(
    folder_path: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<PurgeOutcome, String> {
    validate_virtual_folder(&folder_path, "folder_path")?;
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/folders/purge", base_url);
    diagnostics.push("info", "ingestor", format!("Purging Ingestor folder '{}' at '{}'", folder_path, url));
    #[derive(Serialize)]
    struct PurgeFolderPayload {
        folder_path: String,
    }
    let response_res = ingestor.destructive(reqwest::Method::DELETE, &url).json(&PurgeFolderPayload { folder_path: folder_path.clone() }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to purge folder via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully purged folder '{}' in {}ms", folder_path, elapsed));
    Ok(parse_purge_outcome(&body))
}

#[tauri::command]
pub async fn auto_purge_ingestor_recycle_bin<R: Runtime>(
    policy: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/recycle-bin/auto-purge", base_url);
    diagnostics.push("info", "ingestor", format!("Triggering auto-purge (policy: {}) at '{}'", policy, url));
    #[derive(Serialize)]
    struct AutoPurgePayload {
        policy: String,
    }
    let response_res = ingestor.destructive(reqwest::Method::POST, &url).json(&AutoPurgePayload { policy: policy.clone() }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to trigger auto-purge via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully triggered auto-purge (policy: {}) in {}ms", policy, elapsed));
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderColorResponse {
    pub virtual_folder: String,
    pub color: String,
}

#[tauri::command]
pub async fn list_ingestor_folder_colors<R: Runtime>(
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<Vec<FolderColorResponse>, String> {
    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/folders/colors", base_url);
    diagnostics.push("info", "ingestor", format!("Listing folder colors from '{}'", url));

    let response_res = ingestor.get(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to list folder colors via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_default();

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    let parsed = serde_json::from_str::<Vec<FolderColorResponse>>(&body).map_err(|e| {
        let err = format!("Failed to parse folder colors response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    Ok(parsed)
}

#[tauri::command]
pub async fn set_ingestor_folder_color<R: Runtime>(
    virtual_folder: String,
    color: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    validate_virtual_folder(&virtual_folder, "virtual_folder")?;
    if !is_valid_folder_color(&color) {
        return Err(format!(
            "Invalid folder colour '{}': expected #rrggbb or one of {}",
            color,
            NAMED_FOLDER_COLORS.join(", ")
        ));
    }

    let start_time = std::time::Instant::now();
    let ingestor = IngestorClient::connect(&app, api_base_url_override)?;
    let base_url = ingestor.base_url.clone();
    let url = format!("{}/api/folders/colors", base_url);
    diagnostics.push("info", "ingestor", format!("Setting folder '{}' color to '{}' at '{}'", virtual_folder, color, url));

    #[derive(Serialize)]
    struct SetColorPayload {
        virtual_folder: String,
        color: String,
    }

    let response_res = ingestor
        .put(&url)
        .json(&SetColorPayload {
            virtual_folder,
            color,
        })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to set folder color via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = read_body_capped(response).await.unwrap_or_default();

    if !status.is_success() {
        let err = http_error(status, &url, &body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strict_readiness_valid_asset_passes() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            true,
            "D:\\Media\\clip1.mp4",
            10000,
            0,
            10000,
            25,
            1,
            0,
        );
        assert!(ready);
        assert!(reason.is_none());
    }

    #[test]
    fn test_strict_readiness_mezzanine_false_fails() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            false,
            "D:\\Media\\clip1.mp4",
            10000,
            0,
            10000,
            25,
            1,
            0,
        );
        assert!(!ready);
        assert!(reason.unwrap().contains("mezzanine_ok = false"));
    }

    #[test]
    fn test_strict_readiness_temp_path_fails() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            true,
            "D:\\Media\\.tmp_123_clip1.mp4",
            10000,
            0,
            10000,
            25,
            1,
            0,
        );
        assert!(!ready);
        assert!(reason.unwrap().contains("transient/staging path"));
    }

    #[test]
    fn test_strict_readiness_empty_path_fails() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            true,
            "",
            10000,
            0,
            10000,
            25,
            1,
            0,
        );
        assert!(!ready);
        assert!(reason.unwrap().contains("current_path is empty"));
    }

    #[test]
    fn test_strict_readiness_invalid_fps_fails() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            true,
            "D:\\Media\\clip1.mp4",
            10000,
            0,
            10000,
            0,
            1,
            0,
        );
        assert!(!ready);
        assert!(reason.unwrap().contains("Invalid rational FPS"));
    }

    #[test]
    fn test_strict_readiness_invalid_trim_bounds_fails() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            true,
            "D:\\Media\\clip1.mp4",
            10000,
            5000,
            4000, // trim_out < trim_in
            25,
            1,
            0,
        );
        assert!(!ready);
        assert!(reason.unwrap().contains("Invalid trim bounds"));
    }

    /// Audit F-3: the v1 / batch paths must reach the same verdict as the v2
    /// library mapping. Registry A holds rows that are
    /// `status = ready, mezzanine_ok = 0`; before this, the same asset was red
    /// in the library and green in the rundown.
    #[test]
    fn apply_strict_readiness_downgrades_ready_with_failed_mezzanine() {
        let asset = AssetResponse {
            uuid: "u".into(),
            current_path: r"D:\Media\channel9hdtv_ac3.mp4".into(),
            duration_ms: 10_000,
            trim_in_ms: 0,
            trim_out_ms: 10_000,
            rating: "none".into(),
            tp: "false".into(),
            status: "ready".into(),
            display_name: None,
            virtual_folder: None,
            deleted_at: None,
            original_virtual_folder: None,
            mezzanine_ok: Some(false),
            fps: Some(25.0),
            fps_num: Some(25),
            fps_den: Some(1),
            total_frames: None,
            gop_frames: None,
            keyframe_safe_start_ms: None,
            warnings: Some(vec!["duration_delta_exceeded".into()]),
            playoutvue_id: None,
            qc_report: None,
            loudness: None,
        };

        let mapped = apply_strict_readiness(asset);
        assert_eq!(mapped.status, "error");
        assert!(mapped
            .warnings
            .unwrap()
            .iter()
            .any(|w| w.contains("mezzanine_ok")));
    }

    /// A v1 payload that omits the optional fields must not be failed on them.
    #[test]
    fn apply_strict_readiness_tolerates_a_sparse_v1_payload() {
        let asset = AssetResponse {
            uuid: "u".into(),
            current_path: r"D:\Media\clip.mp4".into(),
            duration_ms: 10_000,
            trim_in_ms: 0,
            // v1 uses 0 for "to the end of the file".
            trim_out_ms: 0,
            rating: "none".into(),
            tp: "false".into(),
            status: "ready".into(),
            display_name: None,
            virtual_folder: None,
            deleted_at: None,
            original_virtual_folder: None,
            mezzanine_ok: None,
            fps: None,
            fps_num: None,
            fps_den: None,
            total_frames: None,
            gop_frames: None,
            keyframe_safe_start_ms: None,
            warnings: None,
            playoutvue_id: None,
            qc_report: None,
            loudness: None,
        };

        assert_eq!(apply_strict_readiness(asset).status, "ready");
    }

    /// A staging path is never playable, on any endpoint.
    #[test]
    fn apply_strict_readiness_rejects_a_staging_path() {
        let asset = AssetResponse {
            uuid: "u".into(),
            current_path: r"D:\Media\.tmp_clip.mp4".into(),
            duration_ms: 10_000,
            trim_in_ms: 0,
            trim_out_ms: 10_000,
            rating: "none".into(),
            tp: "false".into(),
            status: "ready".into(),
            display_name: None,
            virtual_folder: None,
            deleted_at: None,
            original_virtual_folder: None,
            mezzanine_ok: Some(true),
            fps: Some(25.0),
            fps_num: Some(25),
            fps_den: Some(1),
            total_frames: None,
            gop_frames: None,
            keyframe_safe_start_ms: None,
            warnings: None,
            playoutvue_id: None,
            qc_report: None,
            loudness: None,
        };

        assert_eq!(apply_strict_readiness(asset).status, "processing");
    }

    #[test]
    fn test_strict_readiness_blocking_qc_errors_fails() {
        let (ready, reason) = evaluate_strict_readiness(
            "ready",
            true,
            "D:\\Media\\clip1.mp4",
            10000,
            0,
            10000,
            25,
            1,
            2, // 2 blocking QC errors
        );
        assert!(!ready);
        assert!(reason.unwrap().contains("2 blocking QC findings"));
    }

    #[test]
    fn test_map_v2_to_asset_response_hydrates_metadata_and_qc() {
        let v2 = V2AssetDto {
            uuid: "asset-v2-123".into(),
            playoutvue_id: "asset-v2-123".into(),
            current_path: "D:\\Mezzanine\\asset1.mp4".into(),
            duration_ms: 15000,
            trim_in_ms: 0,
            trim_out_ms: 15000,
            fps_num: 50,
            fps_den: 1,
            mezzanine_ok: true,
            status: "ready".into(),
            display_name: Some("Asset Alpha".into()),
            virtual_folder: Some("/Promos".into()),
            rating: Some("12".into()),
            tp: Some("true".into()),
            qc_report: Some(V2QcReportDto {
                passed: true,
                blocking_errors: 0,
                warnings_count: 1,
                findings: vec![V2QcFindingDto {
                    severity: "warning".into(),
                    code: "loudness_dynamic_mode".into(),
                    message: "Short clip dynamically normalized".into(),
                    measured: Some("-23.1".into()),
                    expected: Some("-23.0".into()),
                }],
            }),
            loudness: Some(V2LoudnessDto {
                integrated_lufs: Some(-23.1),
                true_peak_dbtp: Some(-1.2),
                lra_lu: Some(5.4),
                mode: Some("ebu_r128".into()),
            }),
            warnings: vec!["Loudness adjusted".into()],
            deleted_at: None,
            original_virtual_folder: None,
            total_frames: Some(750),
            gop_frames: Some(50),
            keyframe_safe_start_ms: Some(0),
        };

        let mapped = map_v2_to_asset_response(v2);
        assert_eq!(mapped.status, "ready");
        assert_eq!(mapped.uuid, "asset-v2-123");
        assert_eq!(mapped.playoutvue_id, Some("asset-v2-123".into()));
        assert_eq!(mapped.fps, Some(50.0));
        assert_eq!(mapped.fps_num, Some(50));
        assert_eq!(mapped.fps_den, Some(1));
        assert!(mapped.qc_report.is_some());
        assert_eq!(mapped.qc_report.unwrap().findings.len(), 1);
        assert!(mapped.loudness.is_some());
        assert_eq!(mapped.loudness.unwrap().integrated_lufs, Some(-23.1));
        // Frame geometry must survive the V2 mapping (the V2 route serves the
        // V1 row shape, so these are always on the wire).
        assert_eq!(mapped.total_frames, Some(750));
        assert_eq!(mapped.gop_frames, Some(50));
        assert_eq!(mapped.keyframe_safe_start_ms, Some(0));
    }

    #[test]
    fn map_v2_keeps_missing_status() {
        // TRIM-CONTRACT-AUDIT C-4: the transcoder marks a ready asset whose
        // mezzanine vanished as `missing`, with mezzanine_ok still true. It used
        // to fall through to `processing` ("retry in a moment").
        let v2: V2AssetDto = serde_json::from_value(serde_json::json!({
            "uuid": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
            "current_path": "D:/Media/gone.mp4",
            "duration_ms": 10000,
            "trim_in_ms": 0,
            "trim_out_ms": 10000,
            "fps_num": 25,
            "fps_den": 1,
            "mezzanine_ok": true,
            "status": "missing"
        }))
        .unwrap();
        let mapped = map_v2_to_asset_response(v2);
        assert_eq!(mapped.status, "missing");
        assert!(mapped
            .warnings
            .unwrap()
            .iter()
            .any(|w| w.contains("'missing' is not ready")));
    }
    // ── Audit T2-6 ───────────────────────────────────────────────────────────

    #[test]
    fn validate_uuid_accepts_only_canonical_uuids() {
        assert_eq!(
            validate_uuid(" 3F2504E0-4f89-11d3-9a0c-0305e82c3301 ").unwrap(),
            "3F2504E0-4f89-11d3-9a0c-0305e82c3301"
        );
        for bad in [
            "",
            "3f2504e04f8911d39a0c0305e82c3301",
            "../folders/purge",
            "3f2504e0-4f89-11d3-9a0c-0305e82c330",
            "3f2504e0-4f89-11d3-9a0c-0305e82c33011",
            "3f2504e0-4f89-11d3-9a0c-0305e82c330g",
            "3f2504e0_4f89_11d3_9a0c_0305e82c3301",
            "3f2504e0-4f89-11d3-9a0c-0305e82c3301/trash",
            "3f2504e0-4f89-11d3-9a0c-0305e82c3301?x=1",
        ] {
            assert!(validate_uuid(bad).is_err(), "{}", bad);
        }
    }

    #[test]
    fn base_url_override_is_restricted_to_loopback_or_configured_host() {
        let cfg = "http://ingest-host.local:4353";
        assert_eq!(resolve_base_url(cfg, ""), cfg);
        assert_eq!(resolve_base_url(cfg, "http://127.0.0.1:4353/"), "http://127.0.0.1:4353");
        assert_eq!(resolve_base_url(cfg, "http://localhost:9000"), "http://localhost:9000");
        assert_eq!(resolve_base_url(cfg, "http://[::1]:9000"), "http://[::1]:9000");
        assert_eq!(resolve_base_url(cfg, "https://INGEST-HOST.local:8443"), "https://INGEST-HOST.local:8443");
        // Untrusted: different host, non-http scheme, garbage.
        assert_eq!(resolve_base_url(cfg, "http://evil.example.com"), cfg);
        assert_eq!(resolve_base_url(cfg, "http://user@evil.example.com"), cfg);
        assert_eq!(resolve_base_url(cfg, "ftp://127.0.0.1"), cfg);
        assert_eq!(resolve_base_url(cfg, "not a url"), cfg);
    }

    #[test]
    fn url_host_parsing() {
        assert_eq!(url_host("http://127.0.0.1:4353/api").as_deref(), Some("127.0.0.1"));
        assert_eq!(url_host("https://Host.Example/").as_deref(), Some("host.example"));
        assert_eq!(url_host("http://[::1]:80").as_deref(), Some("::1"));
        assert_eq!(url_host("http://u:p@h.example:1/x").as_deref(), Some("h.example"));
        assert_eq!(url_host("h.example"), None);
        assert_eq!(url_host("http://"), None);
    }

    // ── PlayoutTranscode 1.0.0 contract (2026-09-18 remediation) ────────────

    fn built(req: reqwest::RequestBuilder) -> reqwest::Request {
        req.build().expect("request builds")
    }

    fn header<'a>(req: &'a reqwest::Request, name: &str) -> Option<&'a str> {
        req.headers().get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn token_header_is_sent_only_when_configured() {
        let client = reqwest::Client::new();
        let r = built(apply_auth(client.get("http://127.0.0.1:4353/api/assets"), "   "));
        assert!(header(&r, API_TOKEN_HEADER).is_none());
        let r = built(apply_auth(client.get("http://127.0.0.1:4353/api/assets"), " abc123 "));
        assert_eq!(header(&r, API_TOKEN_HEADER), Some("abc123"));
    }

    #[test]
    fn destructive_requests_carry_confirmation_and_token() {
        let ingestor = IngestorClient {
            client: reqwest::Client::new(),
            base_url: "http://127.0.0.1:4353".into(),
            token: "tok".into(),
        };
        let r = built(ingestor.destructive(
            reqwest::Method::DELETE,
            "http://127.0.0.1:4353/api/assets/3f2504e0-4f89-11d3-9a0c-0305e82c3301/purge",
        ));
        assert_eq!(*r.method(), reqwest::Method::DELETE);
        assert_eq!(header(&r, CONFIRM_DESTRUCTIVE_HEADER), Some("yes"));
        assert_eq!(header(&r, API_TOKEN_HEADER), Some("tok"));
        // Reversible routes never carry the confirmation header.
        let r = built(ingestor.put("http://127.0.0.1:4353/api/assets/x/trim"));
        assert!(header(&r, CONFIRM_DESTRUCTIVE_HEADER).is_none());
        assert_eq!(header(&r, API_TOKEN_HEADER), Some("tok"));
        // No token configured: no token header at all.
        let anon = IngestorClient { token: String::new(), ..ingestor };
        let r = built(anon.get("http://127.0.0.1:4353/api/assets"));
        assert!(header(&r, API_TOKEN_HEADER).is_none());
    }

    #[test]
    fn rating_value_uppercases_only_the_age_token() {
        assert_eq!(normalize_rating_value(" 16 "), "16");
        assert_eq!(normalize_rating_value("k"), "K");
        assert_eq!(normalize_rating_value("none"), "NONE");
        // The metadata tail is passed through byte-for-byte: lowercase JSON
        // keys and Greek advisory text must not be touched.
        let tail = r#"NONE|MOVIE|[{"start":0,"end":120000,"text":"Περιέχει σκηνές βίας"}]"#;
        assert_eq!(
            normalize_rating_value(&format!(" k |{}", tail)),
            format!("K|{}", tail)
        );
    }

    #[test]
    fn paging_decision() {
        // Pre-pagination server: no X-Total-Count -> the first body is everything.
        assert!(!needs_next_page(false, None, None, 1000, 1000, 1));
        // Total known: keep going until we hold it all.
        assert!(needs_next_page(true, Some(2500), Some(1000), 1000, 1000, 1));
        assert!(needs_next_page(true, Some(2500), Some(1000), 2000, 1000, 2));
        assert!(!needs_next_page(true, Some(2500), Some(1000), 2500, 500, 3));
        // Library of exactly one page.
        assert!(!needs_next_page(true, Some(1000), Some(1000), 1000, 1000, 1));
        // A short page ends the walk even if the total claims more.
        assert!(!needs_next_page(true, Some(5000), Some(1000), 400, 400, 1));
        // Unparseable total: fall back to the page-size heuristic.
        assert!(needs_next_page(true, None, None, 1000, 1000, 1));
        assert!(!needs_next_page(true, None, None, 999, 999, 1));
        // Empty page and the page cap always stop.
        assert!(!needs_next_page(true, Some(9), None, 0, 0, 1));
        assert!(!needs_next_page(true, Some(1_000_000), Some(1000), 100_000, 1000, LIST_MAX_PAGES));
    }

    #[test]
    fn http_errors_are_mapped_to_operator_wording() {
        let url = "http://127.0.0.1:4353/api/assets/x/purge";
        let e = http_error(reqwest::StatusCode::UNAUTHORIZED, url, r#"{"error":"unauthorized"}"#);
        assert!(e.contains("HTTP 401") && e.contains("API token"), "{}", e);
        let e = http_error(reqwest::StatusCode::PRECONDITION_REQUIRED, url, r#"{"error":"confirmation_required"}"#);
        assert!(e.contains("HTTP 428") && e.contains("confirmation"), "{}", e);
        let e = http_error(reqwest::StatusCode::UNPROCESSABLE_ENTITY, url, r#"{"error":"invalid folder_path"}"#);
        assert!(e.contains("HTTP 422") && e.contains("virtual folder path rejected"), "{}", e);
        let e = http_error(reqwest::StatusCode::SERVICE_UNAVAILABLE, url, r#"{"error":"probe_unavailable"}"#);
        assert!(e.contains("HTTP 503") && e.contains("FFmpeg"), "{}", e);
        let e = http_error(reqwest::StatusCode::NOT_FOUND, url, r#"{"error":"asset not found","result":{}}"#);
        assert!(e.contains("HTTP 404") && e.contains("asset not found"), "{}", e);
        // Non-JSON bodies are passed through with control characters stripped.
        let e = http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, url, "plain text\r\nbody");
        assert!(e.contains("HTTP 500") && e.contains("plain textbody"), "{}", e);
        assert!(e.ends_with(&format!("[{}]", url)), "{}", e);
        // Oversized bodies are bounded.
        let e = http_error(reqwest::StatusCode::BAD_GATEWAY, url, &"x".repeat(5000));
        assert!(e.len() < 400, "{}", e.len());
        assert_eq!(describe_error_code(""), "no details");
    }

    #[test]
    fn auth_rejection_is_tracked_from_non_exempt_routes_only() {
        AUTH_REJECTED.store(false, Ordering::Relaxed);
        note_auth_outcome(reqwest::StatusCode::UNAUTHORIZED, "/api/health");
        assert!(!auth_rejected(), "health is exempt from the token");
        note_auth_outcome(reqwest::StatusCode::UNAUTHORIZED, "/api/assets");
        assert!(auth_rejected());
        note_auth_outcome(reqwest::StatusCode::NOT_FOUND, "/api/assets/x");
        assert!(auth_rejected(), "a 404 says nothing about the token");
        note_auth_outcome(reqwest::StatusCode::OK, "/api/v2/health");
        assert!(auth_rejected(), "an exempt route cannot clear it either");
        note_auth_outcome(reqwest::StatusCode::OK, "/api/assets");
        assert!(!auth_rejected());
    }

    #[test]
    fn virtual_folder_rules_mirror_the_ingestor() {
        for ok in ["/", "/Promos", "/Promos/2026", "/A B/c.d", "/Ελληνικά"] {
            assert!(is_valid_virtual_folder(ok), "{}", ok);
        }
        for bad in ["", "Promos", "/Promos/", "//x", "/a//b", "/ a", "/a ", "/.", "/..", "/a/../b", "/a\tb"] {
            assert!(!is_valid_virtual_folder(bad), "{:?}", bad);
        }
        assert!(!is_valid_virtual_folder(&format!("/{}", "x".repeat(600))));
    }

    #[test]
    fn folder_colour_rules_mirror_the_ingestor() {
        for ok in ["", "#e63946", "#ABCDEF", "red", "Grey", "default"] {
            assert!(is_valid_folder_color(ok), "{}", ok);
        }
        for bad in ["#fff", "#gggggg", "e63946", "red;", "url(x)", "expression(1)"] {
            assert!(!is_valid_folder_color(bad), "{}", bad);
        }
    }

    #[test]
    fn display_names_are_trimmed_and_bounded() {
        assert_eq!(validate_display_name("  Promo A  ").unwrap(), "Promo A");
        assert!(validate_display_name("   ").is_err());
        assert!(validate_display_name("a\nb").is_err());
        assert!(validate_display_name(&"x".repeat(256)).is_err());
        assert!(validate_display_name(&"x".repeat(255)).is_ok());
    }

    #[test]
    fn purge_outcome_parses_structured_and_legacy_bodies() {
        let o = parse_purge_outcome(
            r#"{"operation":"purge_asset","rows_deleted":1,"media_removed":false,"sidecar_removed":false,"skipped_referenced_files":[],"cleanup_failures":[],"warnings":["asset was not ready; source file kept"]}"#,
        );
        assert_eq!(o.rows_deleted, 1);
        assert!(!o.media_removed);
        assert_eq!(o.warnings.len(), 1);
        let legacy = parse_purge_outcome("");
        assert_eq!(legacy.rows_deleted, 0);
        assert!(!legacy.media_removed && legacy.warnings.is_empty());
        let legacy = parse_purge_outcome(r#"{"success":true}"#);
        assert!(legacy.warnings.is_empty());
    }

    #[test]
    fn v2_page_parser_keeps_frame_geometry_from_the_v1_row_shape() {
        // The Ingestor's /api/v2/assets serves the same rows as /api/assets.
        let body = r#"[{"uuid":"3f2504e0-4f89-11d3-9a0c-0305e82c3301","playoutvue_id":"3f2504e0-4f89-11d3-9a0c-0305e82c3301","current_path":"D:/mezz/a.mp4","duration_ms":10000,"trim_in_ms":0,"trim_out_ms":10000,"rating":"12","tp":"None","status":"ready","display_name":"A","virtual_folder":"/","mezzanine_ok":true,"fps":25.0,"fps_num":25,"fps_den":1,"total_frames":250,"gop_frames":12,"keyframe_safe_start_ms":0,"warnings":[],"keyframe_offsets":[]}]"#;
        let rows = parse_v2_page(body).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].total_frames, Some(250));
        assert_eq!(rows[0].gop_frames, Some(12));
        assert_eq!(rows[0].keyframe_safe_start_ms, Some(0));
        assert_eq!(rows[0].status, "ready");
        let rows = parse_v1_page(body).unwrap();
        assert_eq!(rows[0].total_frames, Some(250));
        assert!(parse_v1_page("not json").is_err());
        assert!(parse_v2_page("{}").is_err());
    }
}
