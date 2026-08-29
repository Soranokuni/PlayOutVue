use quick_xml::{de::from_str, se::to_string};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "configuration")]
pub struct CasparConfiguration {
    #[serde(rename = "log-level", skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    #[serde(rename = "log-align-columns", skip_serializing_if = "Option::is_none")]
    pub log_align_columns: Option<bool>,
    #[serde(rename = "lock-clear-phrase", skip_serializing_if = "Option::is_none")]
    pub lock_clear_phrase: Option<String>,
    #[serde(default)]
    pub paths: CasparPaths,
    #[serde(default)]
    pub channels: CasparChannels,
    #[serde(default)]
    pub controllers: CasparControllers,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amcp: Option<CasparAmcp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub osc: Option<CasparOsc>,
}

impl Default for CasparConfiguration {
    fn default() -> Self {
        Self {
            log_level: Some("info".to_string()),
            log_align_columns: Some(true),
            lock_clear_phrase: Some("secret".to_string()),
            paths: CasparPaths::default(),
            channels: CasparChannels {
                channels: vec![CasparChannel::default()],
            },
            controllers: CasparControllers {
                tcp: vec![CasparTcpController::default()],
            },
            amcp: Some(CasparAmcp::default()),
            osc: Some(CasparOsc::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparPaths {
    #[serde(rename = "media-path", skip_serializing_if = "Option::is_none")]
    pub media_path: Option<String>,
    #[serde(rename = "log-path", skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(rename = "data-path", skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
    #[serde(rename = "template-path", skip_serializing_if = "Option::is_none")]
    pub template_path: Option<String>,
    #[serde(rename = "font-path", skip_serializing_if = "Option::is_none")]
    pub font_path: Option<String>,
}

impl Default for CasparPaths {
    fn default() -> Self {
        Self {
            media_path: Some("C:/CasparCG/Media".to_string()),
            log_path: Some("log/".to_string()),
            data_path: Some("C:/CasparCG/Data".to_string()),
            template_path: Some("template/".to_string()),
            font_path: Some("font/".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CasparChannels {
    #[serde(rename = "channel", default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<CasparChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparChannel {
    #[serde(rename = "video-mode", skip_serializing_if = "Option::is_none")]
    pub video_mode: Option<String>,
    #[serde(default)]
    pub consumers: CasparConsumers,
}

impl Default for CasparChannel {
    fn default() -> Self {
        Self {
            video_mode: Some("1080i5000".to_string()),
            consumers: CasparConsumers {
                screens: vec![CasparScreenConsumer::default()],
                system_audio: vec![CasparSystemAudioConsumer::default()],
                decklinks: Vec::new(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CasparConsumers {
    #[serde(rename = "screen", default, skip_serializing_if = "Vec::is_empty")]
    pub screens: Vec<CasparScreenConsumer>,
    #[serde(rename = "system-audio", default, skip_serializing_if = "Vec::is_empty")]
    pub system_audio: Vec<CasparSystemAudioConsumer>,
    #[serde(rename = "decklink", default, skip_serializing_if = "Vec::is_empty")]
    pub decklinks: Vec<CasparDecklinkConsumer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparScreenConsumer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<i32>,
    #[serde(rename = "aspect-ratio", skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stretch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windowed: Option<bool>,
    #[serde(rename = "key-only", skip_serializing_if = "Option::is_none")]
    pub key_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vsync: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borderless: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(rename = "always-on-top", skip_serializing_if = "Option::is_none")]
    pub always_on_top: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(rename = "sbs-key", skip_serializing_if = "Option::is_none")]
    pub sbs_key: Option<bool>,
    #[serde(rename = "colour-space", skip_serializing_if = "Option::is_none")]
    pub colour_space: Option<String>,
}

impl Default for CasparScreenConsumer {
    fn default() -> Self {
        Self {
            device: Some(1),
            aspect_ratio: Some("default".to_string()),
            stretch: Some("fill".to_string()),
            windowed: Some(true),
            key_only: Some(false),
            vsync: Some(false),
            borderless: Some(false),
            interactive: Some(true),
            always_on_top: Some(false),
            x: Some(0),
            y: Some(0),
            width: Some(0),
            height: Some(0),
            sbs_key: Some(false),
            colour_space: Some("RGB".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparSystemAudioConsumer {
    #[serde(rename = "channel-layout", skip_serializing_if = "Option::is_none")]
    pub channel_layout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<i32>,
}

impl Default for CasparSystemAudioConsumer {
    fn default() -> Self {
        Self {
            channel_layout: Some("stereo".to_string()),
            latency: Some(200),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparDecklinkConsumer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<i32>,
    #[serde(rename = "key-device", skip_serializing_if = "Option::is_none")]
    pub key_device: Option<i32>,
    #[serde(rename = "embedded-audio", skip_serializing_if = "Option::is_none")]
    pub embedded_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyer: Option<String>,
    #[serde(rename = "key-only", skip_serializing_if = "Option::is_none")]
    pub key_only: Option<bool>,
    #[serde(rename = "buffer-depth", skip_serializing_if = "Option::is_none")]
    pub buffer_depth: Option<i32>,
}

impl Default for CasparDecklinkConsumer {
    fn default() -> Self {
        Self {
            device: Some(1),
            key_device: None,
            embedded_audio: Some(false),
            latency: Some("normal".to_string()),
            keyer: Some("external".to_string()),
            key_only: Some(false),
            buffer_depth: Some(3),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CasparControllers {
    #[serde(rename = "tcp", default, skip_serializing_if = "Vec::is_empty")]
    pub tcp: Vec<CasparTcpController>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparTcpController {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

impl Default for CasparTcpController {
    fn default() -> Self {
        Self {
            port: Some(5250),
            protocol: Some("AMCP".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparAmcp {
    #[serde(rename = "media-server", skip_serializing_if = "Option::is_none")]
    pub media_server: Option<CasparMediaServer>,
}

impl Default for CasparAmcp {
    fn default() -> Self {
        Self {
            media_server: Some(CasparMediaServer::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparMediaServer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<i32>,
}

impl Default for CasparMediaServer {
    fn default() -> Self {
        Self {
            host: Some("localhost".to_string()),
            port: Some(8000),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparOsc {
    #[serde(rename = "default-port", skip_serializing_if = "Option::is_none")]
    pub default_port: Option<i32>,
    #[serde(rename = "disable-send-to-amcp-clients", skip_serializing_if = "Option::is_none")]
    pub disable_send_to_amcp_clients: Option<bool>,
}

impl Default for CasparOsc {
    fn default() -> Self {
        Self {
            default_port: Some(6250),
            disable_send_to_amcp_clients: Some(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CasparConfigLoadResult {
    pub path: String,
    pub raw_xml: String,
    pub config: CasparConfiguration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckLinkApplyPayload {
    pub path: String,
    pub channel_index: usize,
    pub output_device: i32,
    pub key_device: Option<i32>,
    pub embedded_audio: Option<bool>,
    pub buffer_depth: Option<i32>,
    pub latency: Option<String>,
    pub keyer: Option<String>,
    pub video_mode: Option<String>,
    pub enable_screen_consumer: Option<bool>,
    pub deploy_templates: Option<bool>,
    pub template_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeckLinkApplyResult {
    pub backup_path: String,
    pub raw_xml: String,
    pub channel_index: usize,
    pub output_device: i32,
    pub templates_deployed: Option<TemplateDeployResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TemplateDeployResult {
    pub template_dir: String,
    pub deployed: Vec<String>,
    pub skipped: Vec<String>,
}

const TEMPLATE_ADVISORY: &str = include_str!("../../public/templates/playout/advisory.html");
const TEMPLATE_CRAWL: &str = include_str!("../../public/templates/playout/crawl.html");
const TEMPLATE_GSAP: &str = include_str!("../../public/templates/playout/vendor/gsap.min.js");

const LOGO_K: &[u8] = include_bytes!("../../logos/K.png");
const LOGO_8: &[u8] = include_bytes!("../../logos/8.png");
const LOGO_12: &[u8] = include_bytes!("../../logos/12.png");
const LOGO_16: &[u8] = include_bytes!("../../logos/16.png");
const LOGO_18: &[u8] = include_bytes!("../../logos/18.png");

#[tauri::command]
pub async fn deploy_caspar_templates(
    template_path: Option<String>,
    media_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<TemplateDeployResult, String> {
    let base_dir = if let Some(ref p) = template_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            PathBuf::from(trimmed)
        } else {
            PathBuf::from("C:/CasparCG/template")
        }
    } else {
        PathBuf::from("C:/CasparCG/template")
    };

    let target_dir = base_dir.join("playout");
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create template directory '{}': {}", target_dir.display(), e))?;

    let vendor_dir = target_dir.join("vendor");
    std::fs::create_dir_all(&vendor_dir)
        .map_err(|e| format!("Failed to create vendor directory '{}': {}", vendor_dir.display(), e))?;

    let overwrite_files = overwrite.unwrap_or(false);
    let mut deployed = Vec::new();
    let mut skipped = Vec::new();

    let files = [
        ("advisory.html", TEMPLATE_ADVISORY, target_dir.clone()),
        ("explanation.html", TEMPLATE_ADVISORY, target_dir.clone()),
        ("crawl.html", TEMPLATE_CRAWL, target_dir.clone()),
        ("vendor/gsap.min.js", TEMPLATE_GSAP, target_dir.clone()),
    ];

    for (name, content, dir) in files {
        let file_path = dir.join(name);
        if file_path.exists() && !overwrite_files {
            skipped.push(format!("playout/{}", name));
        } else {
            std::fs::write(&file_path, content)
                .map_err(|e| format!("Failed to write template '{}': {}", file_path.display(), e))?;
            deployed.push(format!("playout/{}", name));
        }
    }

    // Deploy Logos if media_path is provided or if media/ folder is alongside template/
    let logos_dir = if let Some(ref mp) = media_path {
        let trimmed = mp.trim();
        if !trimmed.is_empty() {
            Some(PathBuf::from(trimmed).join("logos"))
        } else {
            None
        }
    } else {
        base_dir.parent().map(|p| p.join("media").join("logos"))
    };

    if let Some(target_logos_dir) = logos_dir {
        let _ = std::fs::create_dir_all(&target_logos_dir);
        let logo_files: [(&str, &[u8]); 5] = [
            ("K.png", LOGO_K),
            ("8.png", LOGO_8),
            ("12.png", LOGO_12),
            ("16.png", LOGO_16),
            ("18.png", LOGO_18),
        ];

        for (name, bytes) in logo_files {
            let file_path = target_logos_dir.join(name);
            if file_path.exists() && !overwrite_files {
                skipped.push(format!("logos/{}", name));
            } else if std::fs::write(&file_path, bytes).is_ok() {
                deployed.push(format!("logos/{}", name));
            }
        }
    }

    Ok(TemplateDeployResult {
        template_dir: target_dir.to_string_lossy().into_owned(),
        deployed,
        skipped,
    })
}

#[tauri::command]
pub async fn open_cg_studio_in_browser(
    template_path: Option<String>,
) -> Result<String, String> {
    let base_dir = if let Some(ref p) = template_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            PathBuf::from(trimmed)
        } else {
            PathBuf::from("C:/CasparCG/template")
        }
    } else {
        PathBuf::from("C:/CasparCG/template")
    };

    let target_file = base_dir.join("playout").join("advisory.html");
    
    // Ensure template is freshly deployed
    let _ = deploy_caspar_templates(template_path.clone(), None, Some(true)).await;

    let target_url = if target_file.exists() {
        target_file.to_string_lossy().to_string()
    } else {
        "http://localhost:5173/templates/playout/advisory.html".to_string()
    };

    #[cfg(target_os = "windows")]
    {
        let formatted_target = if target_url.starts_with("http") {
            target_url.clone()
        } else {
            format!("file:///{}", target_url.replace('\\', "/"))
        };
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &formatted_target])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    Ok(target_url)
}

#[tauri::command]
pub async fn find_default_caspar_config() -> Option<String> {
    default_config_candidates()
        .into_iter()
        .find(|candidate| candidate.exists() && candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn load_caspar_config(path: Option<String>) -> Result<CasparConfigLoadResult, String> {
    let resolved_path = resolve_requested_path(path)?;

    if !resolved_path.exists() {
        let config = CasparConfiguration::default();
        let raw_xml = serialize_config(&config)?;
        return Ok(CasparConfigLoadResult {
            path: resolved_path.to_string_lossy().into_owned(),
            raw_xml,
            config,
        });
    }

    let raw_xml = std::fs::read_to_string(&resolved_path)
        .map_err(|error| format!("Failed to read CasparCG config '{}': {}", resolved_path.display(), error))?;
    let config: CasparConfiguration = from_str(&raw_xml)
        .map_err(|error| format!("Failed to parse CasparCG config '{}': {}", resolved_path.display(), error))?;

    Ok(CasparConfigLoadResult {
        path: resolved_path.to_string_lossy().into_owned(),
        raw_xml,
        config,
    })
}

#[tauri::command]
pub async fn save_caspar_config_raw(path: String, raw_xml: String) -> Result<(), String> {
    let target_path = resolve_requested_path(Some(path))?;
    let _: CasparConfiguration = from_str(&raw_xml)
        .map_err(|error| format!("CasparCG config XML is invalid: {}", error))?;
    write_config_file(&target_path, raw_xml)
}

#[tauri::command]
pub async fn save_caspar_config_structured(path: String, config: CasparConfiguration) -> Result<String, String> {
    let target_path = resolve_requested_path(Some(path))?;
    let xml = serialize_config(&config)?;
    write_config_file(&target_path, xml.clone())?;
    Ok(xml)
}

#[tauri::command]
pub async fn apply_caspar_decklink_config(payload: DeckLinkApplyPayload) -> Result<DeckLinkApplyResult, String> {
    let target_path = resolve_requested_path(Some(payload.path))?;
    let mut config = if target_path.exists() {
        let raw_xml = std::fs::read_to_string(&target_path)
            .map_err(|error| format!("Failed to read CasparCG config '{}': {}", target_path.display(), error))?;
        from_str::<CasparConfiguration>(&raw_xml)
            .map_err(|error| format!("Failed to parse CasparCG config '{}': {}", target_path.display(), error))?
    } else {
        CasparConfiguration::default()
    };

    while config.channels.channels.len() <= payload.channel_index {
        config.channels.channels.push(CasparChannel::default());
    }

    let channel = &mut config.channels.channels[payload.channel_index];

    if let Some(ref video_mode) = payload.video_mode {
        if !video_mode.trim().is_empty() {
            channel.video_mode = Some(video_mode.trim().to_string());
        }
    }

    let decklink = CasparDecklinkConsumer {
        device: Some(payload.output_device),
        key_device: payload.key_device,
        embedded_audio: payload.embedded_audio,
        buffer_depth: payload.buffer_depth,
        latency: payload.latency,
        keyer: payload.keyer,
        key_only: Some(false),
    };

    channel.consumers.decklinks = vec![decklink];

    // Ensure screen consumer is present if requested
    if payload.enable_screen_consumer.unwrap_or(true) {
        if channel.consumers.screens.is_empty() {
            channel.consumers.screens = vec![CasparScreenConsumer::default()];
        }
    }

    // Ensure system audio consumer is present
    if channel.consumers.system_audio.is_empty() {
        channel.consumers.system_audio = vec![CasparSystemAudioConsumer::default()];
    }

    // Ensure OSC default port 6250 is configured
    if config.osc.is_none() {
        config.osc = Some(CasparOsc::default());
    }

    // Optional template deployment
    let mut templates_deployed = None;
    if payload.deploy_templates.unwrap_or(true) {
        let template_base = payload.template_path
            .clone()
            .or_else(|| config.paths.template_path.clone())
            .unwrap_or_else(|| "C:/CasparCG/template/".to_string());

        let media_base = config.paths.media_path.clone();
        if let Ok(res) = deploy_caspar_templates(Some(template_base), media_base, Some(false)).await {
            templates_deployed = Some(res);
        }
    }

    let backup_path = backup_config(&target_path)?;
    let xml = serialize_config(&config)?;
    write_config_file_atomic(&target_path, xml.clone())?;

    Ok(DeckLinkApplyResult {
        backup_path: backup_path.to_string_lossy().into_owned(),
        raw_xml: xml,
        channel_index: payload.channel_index,
        output_device: payload.output_device,
        templates_deployed,
    })
}

#[tauri::command]
pub async fn caspar_test_connection() -> Result<String, String> {
    use tokio::net::TcpStream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::timeout;
    use std::time::Duration;

    let mut stream = timeout(
        Duration::from_millis(1500),
        TcpStream::connect("127.0.0.1:5250"),
    )
    .await
    .map_err(|_| "Connection to CasparCG timed out".to_string())?
    .map_err(|error| format!("Failed to connect to CasparCG: {}", error))?;

    timeout(
        Duration::from_millis(1500),
        stream.write_all(b"INFO\r\n"),
    )
    .await
    .map_err(|_| "Timed out sending test command".to_string())?
    .map_err(|error| format!("Failed to send test command: {}", error))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        match timeout(Duration::from_millis(500), stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => {
                response.extend_from_slice(&chunk[..read]);
                if read < chunk.len() {
                    break;
                }
            }
            Ok(Err(error)) => return Err(format!("Read error: {}", error)),
            Err(_) => break,
        }
    }

    Ok(String::from_utf8_lossy(&response).trim().to_string())
}

fn backup_config(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }

    let timestamp = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("casparcg");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("config");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));

    let backup_name = format!("{}.{}.{}.bak", stem, timestamp, ext);
    let backup_path = parent.join(backup_name);

    std::fs::copy(path, &backup_path)
        .map_err(|error| format!("Failed to backup config to '{}': {}", backup_path.display(), error))?;

    Ok(backup_path)
}

fn write_config_file_atomic(path: &Path, contents: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory '{}': {}", parent.display(), error))?;
    }

    let tmp_path = path.with_extension("config.tmp");
    std::fs::write(&tmp_path, contents)
        .map_err(|error| format!("Failed to write temp config '{}': {}", tmp_path.display(), error))?;
    std::fs::rename(&tmp_path, path)
        .map_err(|error| format!("Failed to finalize config '{}': {}", path.display(), error))
}

fn write_config_file(path: &Path, contents: String) -> Result<(), String> {
    write_config_file_atomic(path, contents)
}

fn serialize_config(config: &CasparConfiguration) -> Result<String, String> {
    let body = to_string(config).map_err(|error| format!("Failed to serialize CasparCG config: {}", error))?;
    Ok(format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}\n", body))
}

fn resolve_requested_path(path: Option<String>) -> Result<PathBuf, String> {
    let trimmed = path.unwrap_or_default().trim().to_string();
    if !trimmed.is_empty() {
        return Ok(PathBuf::from(trimmed));
    }

    if let Some(found) = find_default_caspar_config_blocking() {
        return Ok(found);
    }

    Ok(PathBuf::from("C:/CasparCG/casparcg.config"))
}

fn find_default_caspar_config_blocking() -> Option<PathBuf> {
    default_config_candidates()
        .into_iter()
        .find(|candidate| candidate.exists() && candidate.is_file())
}

fn default_config_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("casparcg.config"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("casparcg.config"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("casparcg.config"));
        }
    }

    candidates.push(PathBuf::from("C:/CasparCG/casparcg.config"));
    candidates.push(PathBuf::from("C:/CasparLauncher/casparcg.config"));
    candidates
}