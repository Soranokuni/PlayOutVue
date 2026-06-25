use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State, Manager};

use crate::runtime_settings::get_ingestor_api_base_url;

const REQUEST_TIMEOUT_SECS: u64 = 5;
const HEARTBEAT_INTERVAL_SECS: u64 = 5;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HeartbeatEvent {
    pub online: bool,
    pub last_seen_at: u64,
    pub error: Option<String>,
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
    let url = format!("{}/api/health", base_url);
    diagnostics.push("info", "ingestor", format!("Checking Ingestor API health at '{}'", url));
    let client = build_client()?;

    let res = match client.get(&url).send().await {
        Ok(response) => Ok(response.status().is_success()),
        Err(error) => Err(format!("Ingestor health check failed for '{}': {}", url, error)),
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

    let url = format!("{}/api/assets", base_url);
    diagnostics.push("info", "ingestor", format!("Listing Ingestor API assets from '{}'", url));
    let client = build_client()?;

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
            "Listed {} assets from Ingestor API in {}ms (HTTP request took {}ms)",
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

    let url = format!("{}/api/assets/{}", base_url, uuid);
    diagnostics.push("info", "ingestor", format!("Resolving Ingestor asset '{}' from '{}'", uuid, url));
    let client = build_client()?;

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
            "Resolved asset '{}' from Ingestor API in {}ms (HTTP request took {}ms)",
            uuid, total_elapsed, elapsed_req
        ),
    );
    Ok(parsed)
}

#[tauri::command]
pub async fn update_ingestor_trim<R: Runtime>(
    uuid: String,
    trim_in_ms: i64,
    trim_out_ms: i64,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
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

#[tauri::command]
pub async fn move_ingestor_asset<R: Runtime>(
    uuid: String,
    virtual_folder: String,
    app: AppHandle<R>,
    api_base_url_override: Option<String>,
    diagnostics: State<'_, crate::diagnostics::DiagnosticState>,
) -> Result<(), String> {
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

#[tauri::command]
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
