use quick_xml::{de::from_str, se::to_string};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

fn write_config_file(path: &Path, contents: String) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create config directory '{}': {}", parent.display(), error))?;
    }

    std::fs::write(path, contents)
        .map_err(|error| format!("Failed to save CasparCG config '{}': {}", path.display(), error))
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