use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State, Manager};

use crate::runtime_settings::get_ingestor_api_base_url;

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
        total_frames: None,
        gop_frames: None,
        keyframe_safe_start_ms: None,
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
}

fn is_safe_path_component(component: &str) -> bool {
    !component.is_empty() 
        && !component.contains("..") 
        && !component.contains('/') 
        && !component.contains('\\')
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn resolve_base_url(app_base_url: &str, override_url: &str) -> String {
    let raw = if override_url.trim().is_empty() {
        app_base_url.trim()
    } else {
        override_url.trim()
    };
    raw.trim_end_matches('/').to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn check_ingestor_health<R: Runtime>(
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<bool, String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let client = build_client()?;

    // 1. Try V2 health route first
    let v2_url = format!("{}/api/v2/health", base_url);
    diagnostics.push("info", "ingestor", format!("Checking Ingestor API V2 health at '{}'", v2_url));
    let v2_res = client.get(&v2_url).send().await;

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
    let res = match client.get(&v1_url).send().await {
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
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let client = build_client()?;

    // 1. Primary: query V2 assets endpoint
    let v2_url = format!("{}/api/v2/assets", base_url);
    diagnostics.push("info", "ingestor", format!("Listing Ingestor assets from V2 API at '{}'", v2_url));

    let v2_res = client.get(&v2_url).send().await;
    if let Ok(response) = v2_res {
        let status = response.status();
        if status.is_success() {
            let body = response.text().await.map_err(|e| {
                format!("Failed to read Ingestor V2 list response: {}", e)
            })?;
            if let Ok(v2_assets) = serde_json::from_str::<Vec<V2AssetDto>>(&body) {
                let mapped: Vec<AssetResponse> = v2_assets.into_iter().map(map_v2_to_asset_response).collect();
                let elapsed = start_time.elapsed().as_millis();
                diagnostics.push("info", "ingestor", format!("Hydrated {} assets via V2 API in {}ms", mapped.len(), elapsed));
                return Ok(mapped);
            }
        } else if status.as_u16() != 404 {
            // Non-404 V2 error (e.g. 500 server error): report failure without fallback
            let body = response.text().await.unwrap_or_default();
            let err = format!("Ingestor V2 API returned HTTP {}: {}", status.as_u16(), body);
            diagnostics.push("error", "ingestor", err.clone());
            return Err(err);
        }
    }

    // 2. Fallback: query V1 assets endpoint
    let url = format!("{}/api/assets", base_url);
    diagnostics.push("info", "ingestor", format!("Falling back to Ingestor V1 API assets at '{}'", url));

    let response_res = client.get(&url).send().await;
    let elapsed_req = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Ingestor list request failed for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed_req));
        err
    })?;

    let status = response.status();
    let body = response.text().await.map_err(|e| {
        let err = format!("Failed to read Ingestor list response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
        diagnostics.push("error", "ingestor", err.clone());
        return Err(err);
    }

    let parsed = serde_json::from_str::<Vec<AssetResponse>>(&body).map_err(|e| {
        let err = format!(
            "Failed to parse Ingestor list response for '{}': {}. Body: {}",
            url, e, body
        );
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    let total_elapsed = start_time.elapsed().as_millis();
    diagnostics.push(
        "info",
        "ingestor",
        format!(
            "Listed {} assets from Ingestor V1 API in {}ms (HTTP request took {}ms)",
            parsed.len(),
            total_elapsed,
            elapsed_req
        ),
    );
    Ok(parsed)
}

#[tauri::command]
pub async fn resolve_ingestor_asset<R: Runtime>(
    uuid: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<AssetResponse, String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let client = build_client()?;

    // 1. Primary: query V2 single asset endpoint
    let v2_url = format!("{}/api/v2/assets/{}", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Resolving Ingestor asset '{}' from V2 API at '{}'", uuid, v2_url));

    let v2_res = client.get(&v2_url).send().await;
    if let Ok(response) = v2_res {
        let status = response.status();
        if status.is_success() {
            let body = response.text().await.map_err(|e| {
                format!("Failed to read Ingestor V2 asset response: {}", e)
            })?;
            if let Ok(v2_asset) = serde_json::from_str::<V2AssetDto>(&body) {
                let mapped = map_v2_to_asset_response(v2_asset);
                let elapsed = start_time.elapsed().as_millis();
                diagnostics.push("info", "ingestor", format!("Resolved asset '{}' via V2 API in {}ms", uuid, elapsed));
                return Ok(mapped);
            }
        } else if status.as_u16() != 404 {
            let body = response.text().await.unwrap_or_default();
            let err = format!("Ingestor V2 API returned HTTP {} for asset '{}': {}", status.as_u16(), uuid, body);
            diagnostics.push("error", "ingestor", err.clone());
            return Err(err);
        }
    }

    // 2. Fallback: query V1 single asset endpoint
    let url = format!("{}/api/assets/{}", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Falling back to Ingestor V1 asset resolution at '{}'", url));

    let response_res = client.get(&url).send().await;
    let elapsed_req = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Ingestor API request failed for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed_req));
        err
    })?;

    let status = response.status();
    let body = response.text().await.map_err(|e| {
        let err = format!("Failed to read Ingestor API response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
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
    if !is_safe_path_component(&uuid) {
        return Err("SECURITY VIOLATION: Invalid UUID format detected (Path Traversal)".into());
    }

    let start_time = std::time::Instant::now();
    if trim_in_ms < 0 || trim_out_ms < 0 {
        return Err("Trim values must be non-negative".to_string());
    }

    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/trim", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Updating Ingestor asset '{}' trim (in: {}, out: {}) at '{}'", uuid, trim_in_ms, trim_out_ms, url));
    let client = build_client()?;

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct TrimPayload {
        trim_in_ms: i64,
        trim_out_ms: i64,
    }

    let response_res = client
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
    let body = response.text().await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully updated trim for asset '{}' in {}ms", uuid, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn update_ingestor_rating<R: Runtime>(
    uuid: String,
    rating: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let upper = rating.to_ascii_uppercase();

    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/rating", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Updating Ingestor asset '{}' rating to '{}' at '{}'", uuid, upper, url));
    let client = build_client()?;

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct RatingPayload {
        rating: String,
    }

    let response_res = client
        .put(&url)
        .json(&RatingPayload { rating: upper.clone() })
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to update rating via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully updated rating to '{}' for asset '{}' in {}ms", upper, uuid, elapsed));
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

    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/batch", base_url);
    diagnostics.push("info", "ingestor", format!("Resolving batch of {} assets at '{}'", uuids.len(), url));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response_res = client
        .post(&url)
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
    let body = response.text().await.map_err(|e| {
        let err = format!("Failed to read Ingestor batch API response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = format!(
            "Ingestor batch API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
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
    if !is_safe_path_component(&uuid) {
        return Err("SECURITY VIOLATION: Invalid UUID format detected (Path Traversal)".into());
    }
    if virtual_folder.contains("..") {
        return Err("SECURITY VIOLATION: Path traversal sequences detected in virtual_folder".into());
    }

    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/move", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Moving Ingestor asset '{}' to virtual folder '{}' at '{}'", uuid, virtual_folder, url));
    let client = build_client()?;

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct MovePayload {
        virtual_folder: String,
    }

    let response_res = client
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
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
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
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/rename", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Renaming Ingestor asset '{}' to '{}' at '{}'", uuid, display_name, url));
    let client = build_client()?;

    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    struct RenamePayload {
        display_name: String,
    }

    let response_res = client
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
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
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
            let base_url = get_ingestor_api_base_url(&app);
            let url = format!("{}/api/health", base_url.trim_end_matches('/'));
            let (online, error) = match build_client() {
                Ok(client) => match client.get(&url).send().await {
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
                },
                Err(error) => (false, Some(error)),
            };

            let elapsed = start.elapsed().as_millis();

            // Log heartbeat latency to diagnostics if enabled
            if let Some(diagnostics) = app.try_state::<crate::diagnostics::DiagnosticState>() {
                if diagnostics.is_enabled() {
                    if online {
                        diagnostics.push("info", "ingestor", format!("Heartbeat checked in {}ms. Online: true", elapsed));
                    } else {
                        diagnostics.push("warn", "ingestor", format!("Heartbeat failed in {}ms. Offline. Error: {:?}", elapsed, error));
                    }
                }
            }

            let payload = HeartbeatEvent {
                online,
                last_seen_at: now_ms(),
                error,
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
    let start_time = std::time::Instant::now();
    if trim_in_ms < 0 || trim_out_ms < 0 {
        return Err("Trim values must be non-negative".to_string());
    }
    if display_name.trim().is_empty() {
        return Err("Display name must not be empty".to_string());
    }

    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/subclip", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Creating subclip from asset '{}' at '{}'", uuid, url));
    let client = build_client()?;

    #[derive(Serialize)]
    struct SubclipPayload {
        display_name: String,
        trim_in_ms: i64,
        trim_out_ms: i64,
    }

    let response_res = client
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
    let body = response.text().await.map_err(|e| {
        let err = format!("Failed to read subclip response for '{}': {}", url, e);
        diagnostics.push("error", "ingestor", err.clone());
        err
    })?;

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
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
    let start_time = std::time::Instant::now();
    let upper = tp.to_ascii_uppercase();

    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/tp", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Updating Ingestor asset '{}' tp to '{}' at '{}'", uuid, upper, url));
    let client = build_client()?;

    #[derive(Serialize)]
    struct TpPayload {
        tp: String,
    }

    let response_res = client
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
    let body = response.text().await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
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
) -> Result<(), String> {
    let start_time = std::time::Instant::now();

    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );

    let url = format!("{}/api/assets/{}/purge", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Purging Ingestor asset '{}' at '{}'", uuid, url));
    let client = build_client()?;

    let response_res = client
        .delete(&url)
        .send()
        .await;

    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to purge asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());

    if !status.is_success() {
        let err = format!(
            "Ingestor API returned HTTP {} for '{}': {}",
            status.as_u16(),
            url,
            body
        );
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }

    diagnostics.push("info", "ingestor", format!("Successfully purged asset '{}' in {}ms", uuid, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn trash_ingestor_asset<R: Runtime>(
    uuid: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/assets/{}/trash", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Moving Ingestor asset '{}' to Recycle Bin at '{}'", uuid, url));
    let client = build_client()?;
    let response_res = client.post(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to trash asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/folders/trash", base_url);
    diagnostics.push("info", "ingestor", format!("Moving Ingestor folder '{}' to Recycle Bin at '{}'", folder_path, url));
    let client = build_client()?;
    #[derive(Serialize)]
    struct TrashFolderPayload {
        folder_path: String,
    }
    let response_res = client.post(&url).json(&TrashFolderPayload { folder_path: folder_path.clone() }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to trash folder via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/assets/{}/restore", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Restoring Ingestor asset '{}' from Recycle Bin at '{}'", uuid, url));
    let client = build_client()?;
    #[derive(Serialize)]
    struct RestoreAssetPayload {
        target_folder: Option<String>,
    }
    let response_res = client.post(&url).json(&RestoreAssetPayload { target_folder }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to restore asset via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully restored asset '{}' in {}ms", uuid, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn restore_ingestor_folder<R: Runtime>(
    folder_path: String,
    fallback_to_root: Option<bool>,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/folders/restore", base_url);
    diagnostics.push("info", "ingestor", format!("Restoring Ingestor folder '{}' from Recycle Bin at '{}'", folder_path, url));
    let client = build_client()?;
    #[derive(Serialize)]
    struct RestoreFolderPayload {
        folder_path: String,
        fallback_to_root: Option<bool>,
    }
    let response_res = client.post(&url).json(&RestoreFolderPayload { folder_path: folder_path.clone(), fallback_to_root }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to restore folder via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/recycle-bin", base_url);
    let client = build_client()?;
    let response_res = client.get(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to fetch recycle bin via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/recycle-bin/purge", base_url);
    diagnostics.push("info", "ingestor", format!("Emptying Ingestor Recycle Bin at '{}'", url));
    let client = build_client()?;
    let response_res = client.delete(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to empty recycle bin via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully emptied Recycle Bin in {}ms", elapsed));
    Ok(())
}

#[tauri::command]
pub async fn purge_ingestor_folder<R: Runtime>(
    folder_path: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/folders/purge", base_url);
    diagnostics.push("info", "ingestor", format!("Purging Ingestor folder '{}' at '{}'", folder_path, url));
    let client = build_client()?;
    #[derive(Serialize)]
    struct PurgeFolderPayload {
        folder_path: String,
    }
    let response_res = client.request(reqwest::Method::DELETE, &url).json(&PurgeFolderPayload { folder_path: folder_path.clone() }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to purge folder via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        return Err(err);
    }
    diagnostics.push("info", "ingestor", format!("Successfully purged folder '{}' in {}ms", folder_path, elapsed));
    Ok(())
}

#[tauri::command]
pub async fn auto_purge_ingestor_recycle_bin<R: Runtime>(
    policy: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/recycle-bin/auto-purge", base_url);
    diagnostics.push("info", "ingestor", format!("Triggering auto-purge (policy: {}) at '{}'", policy, url));
    let client = build_client()?;
    #[derive(Serialize)]
    struct AutoPurgePayload {
        policy: String,
    }
    let response_res = client.post(&url).json(&AutoPurgePayload { policy: policy.clone() }).send().await;
    let elapsed = start_time.elapsed().as_millis();
    let response = response_res.map_err(|e| {
        let err = format!("Failed to trigger auto-purge via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_else(|_| String::new());
    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/folders/colors", base_url);
    diagnostics.push("info", "ingestor", format!("Listing folder colors from '{}'", url));
    let client = build_client()?;

    let response_res = client.get(&url).send().await;
    let elapsed = start_time.elapsed().as_millis();

    let response = response_res.map_err(|e| {
        let err = format!("Failed to list folder colors via Ingestor API '{}': {}", url, e);
        diagnostics.push("error", "ingestor", format!("{} in {}ms", err, elapsed));
        err
    })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
    if virtual_folder.contains("..") {
        return Err("SECURITY VIOLATION: Path traversal sequences detected in virtual_folder".into());
    }

    let start_time = std::time::Instant::now();
    let base_url = resolve_base_url(
        &get_ingestor_api_base_url(&app),
        &api_base_url_override.unwrap_or_default(),
    );
    let url = format!("{}/api/folders/colors", base_url);
    diagnostics.push("info", "ingestor", format!("Setting folder '{}' color to '{}' at '{}'", virtual_folder, color, url));
    let client = build_client()?;

    #[derive(Serialize)]
    struct SetColorPayload {
        virtual_folder: String,
        color: String,
    }

    let response_res = client
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
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let err = format!("Ingestor API returned HTTP {} for '{}': {}", status.as_u16(), url, body);
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
    }
}

