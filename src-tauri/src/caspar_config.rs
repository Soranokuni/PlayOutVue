use quick_xml::{de::from_str, se::to_string};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "configuration")]
pub struct CasparConfiguration {
    #[serde(rename = "log-level", alias = "log_level", alias = "logLevel", skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    #[serde(rename = "log-align-columns", alias = "log_align_columns", alias = "logAlignColumns", skip_serializing_if = "Option::is_none")]
    pub log_align_columns: Option<bool>,
    #[serde(rename = "lock-clear-phrase", alias = "lock_clear_phrase", alias = "lockClearPhrase", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "media-path", alias = "media_path", alias = "mediaPath", skip_serializing_if = "Option::is_none")]
    pub media_path: Option<String>,
    #[serde(rename = "log-path", alias = "log_path", alias = "logPath", skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(rename = "data-path", alias = "data_path", alias = "dataPath", skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
    #[serde(rename = "template-path", alias = "template_path", alias = "templatePath", skip_serializing_if = "Option::is_none")]
    pub template_path: Option<String>,
    #[serde(rename = "font-path", alias = "font_path", alias = "fontPath", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "channel", alias = "channels", default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<CasparChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparChannel {
    #[serde(rename = "video-mode", alias = "video_mode", alias = "videoMode", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "screen", alias = "screens", default, skip_serializing_if = "Vec::is_empty")]
    pub screens: Vec<CasparScreenConsumer>,
    #[serde(rename = "system-audio", alias = "system_audio", alias = "systemAudio", default, skip_serializing_if = "Vec::is_empty")]
    pub system_audio: Vec<CasparSystemAudioConsumer>,
    #[serde(rename = "decklink", alias = "decklinks", default, skip_serializing_if = "Vec::is_empty")]
    pub decklinks: Vec<CasparDecklinkConsumer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasparScreenConsumer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<i32>,
    #[serde(rename = "aspect-ratio", alias = "aspect_ratio", alias = "aspectRatio", skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stretch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windowed: Option<bool>,
    #[serde(rename = "key-only", alias = "key_only", alias = "keyOnly", skip_serializing_if = "Option::is_none")]
    pub key_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vsync: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub borderless: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    #[serde(rename = "always-on-top", alias = "always_on_top", alias = "alwaysOnTop", skip_serializing_if = "Option::is_none")]
    pub always_on_top: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(rename = "sbs-key", alias = "sbs_key", alias = "sbsKey", skip_serializing_if = "Option::is_none")]
    pub sbs_key: Option<bool>,
    #[serde(rename = "colour-space", alias = "colour_space", alias = "colourSpace", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "channel-layout", alias = "channel_layout", alias = "channelLayout", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "key-device", alias = "key_device", alias = "keyDevice", skip_serializing_if = "Option::is_none")]
    pub key_device: Option<i32>,
    #[serde(rename = "embedded-audio", alias = "embedded_audio", alias = "embeddedAudio", skip_serializing_if = "Option::is_none")]
    pub embedded_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyer: Option<String>,
    #[serde(rename = "key-only", alias = "key_only", alias = "keyOnly", skip_serializing_if = "Option::is_none")]
    pub key_only: Option<bool>,
    #[serde(rename = "buffer-depth", alias = "buffer_depth", alias = "bufferDepth", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "media-server", alias = "media_server", alias = "mediaServer", skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "default-port", alias = "default_port", alias = "defaultPort", skip_serializing_if = "Option::is_none")]
    pub default_port: Option<i32>,
    #[serde(rename = "disable-send-to-amcp-clients", alias = "disable_send_to_amcp_clients", alias = "disableSendToAmcpClients", skip_serializing_if = "Option::is_none")]
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

fn default_decklink_output() -> i32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckLinkApplyPayload {
    #[serde(default)]
    pub path: String,
    #[serde(default, alias = "channel_index")]
    pub channel_index: usize,
    #[serde(default = "default_decklink_output", alias = "output_device")]
    pub output_device: i32,
    #[serde(default, alias = "key_device")]
    pub key_device: Option<i32>,
    #[serde(default, alias = "embedded_audio")]
    pub embedded_audio: Option<bool>,
    #[serde(default, alias = "buffer_depth")]
    pub buffer_depth: Option<i32>,
    #[serde(default)]
    pub latency: Option<String>,
    #[serde(default)]
    pub keyer: Option<String>,
    #[serde(default, alias = "video_mode")]
    pub video_mode: Option<String>,
    #[serde(default, alias = "enable_screen_consumer")]
    pub enable_screen_consumer: Option<bool>,
    #[serde(default, alias = "deploy_templates")]
    pub deploy_templates: Option<bool>,
    #[serde(default, alias = "template_path")]
    pub template_path: Option<String>,
    #[serde(default, alias = "media_path")]
    pub media_path: Option<String>,
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

pub const TEMPLATE_ADVISORY: &str = include_str!("../../public/templates/playout/advisory.html");
pub const TEMPLATE_CRAWL: &str = include_str!("../../public/templates/playout/crawl.html");
pub const TEMPLATE_GSAP: &str = include_str!("../../public/templates/playout/vendor/gsap.min.js");
pub const TEMPLATE_ESR_PRESETS: &str = include_str!("../../public/templates/playout/esr_presets.json");

fn resolve_caspar_template_dir<R: Runtime>(app: Option<&AppHandle<R>>, explicit: Option<&str>) -> PathBuf {
    if let Some(p) = explicit {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let mut pb = PathBuf::from(trimmed);
            if pb.file_name().and_then(|n| n.to_str()) == Some("advisory.html") {
                if let Some(parent) = pb.parent() {
                    pb = parent.to_path_buf();
                }
            }
            if pb.file_name().and_then(|n| n.to_str()) == Some("playout") {
                if let Some(parent) = pb.parent() {
                    return parent.to_path_buf();
                }
            }
            if pb.exists() {
                return pb;
            }
        }
    }

    if let Some(app_handle) = app {
        if let Some(state) = app_handle.try_state::<crate::runtime_settings::RuntimeSettingsState>() {
            let settings = state.snapshot();
            let exe_opt = crate::caspar_process::resolve_caspar_executable(&settings.casparcg_executable_path)
                .or_else(|| crate::caspar_process::resolve_caspar_executable(""));
            if let Some(exe_path) = exe_opt {
                let cwd = crate::caspar_process::resolve_caspar_cwd(&exe_path);
                let cand1 = cwd.join("template");
                let cand2 = cwd.join("templates");
                if cand2.exists() {
                    return cand2;
                }
                return cand1;
            }
        }
    }

    if let Some(exe_path) = crate::caspar_process::resolve_caspar_executable("") {
        let cwd = crate::caspar_process::resolve_caspar_cwd(&exe_path);
        let cand1 = cwd.join("template");
        let cand2 = cwd.join("templates");
        if cand2.exists() {
            return cand2;
        }
        return cand1;
    }

    dirs_next::data_dir()
        .map(|d| d.join("PlayOutVue").join("templates"))
        .unwrap_or_else(|| PathBuf::from("./templates"))
}

#[tauri::command]
pub async fn deploy_caspar_templates<R: Runtime>(
    app: AppHandle<R>,
    template_path: Option<String>,
    _media_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<TemplateDeployResult, String> {
    let base_dir = resolve_caspar_template_dir(Some(&app), template_path.as_deref());
    let target_dir = base_dir.join("playout");
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create template directory '{}': {}", target_dir.display(), e))?;

    let vendor_dir = target_dir.join("vendor");
    std::fs::create_dir_all(&vendor_dir)
        .map_err(|e| format!("Failed to create vendor directory '{}': {}", vendor_dir.display(), e))?;

    let overwrite_files = overwrite.unwrap_or(false);
    let mut deployed = Vec::new();
    let mut skipped = Vec::new();
    let mut advisory_content = {
        let mut found = None;
        for cand in crate::studio_server::resolve_all_workspace_targets("public/templates/playout/advisory.html") {
            if cand.exists() && cand.is_file() {
                if let Ok(disk_content) = std::fs::read_to_string(&cand) {
                    found = Some(disk_content);
                    break;
                }
            }
        }
        found.unwrap_or_else(|| TEMPLATE_ADVISORY.to_string())
    };

    // Check if a saved custom default preset exists, and bake it directly into advisory.html
    if let Some(preset_val) = crate::studio_server::load_saved_default_preset(&app) {
        advisory_content = crate::studio_server::bake_preset_into_template_content(&advisory_content, &preset_val);
    }

    let files: [(&str, &str, PathBuf); 4] = [
        ("advisory.html", &advisory_content, target_dir.clone()),
        ("crawl.html", TEMPLATE_CRAWL, target_dir.clone()),
        ("esr_presets.json", TEMPLATE_ESR_PRESETS, target_dir.clone()),
        ("vendor/gsap.min.js", TEMPLATE_GSAP, target_dir.clone()),
    ];

    for (name, content, dir) in files {
        let file_path = dir.join(name);
        if file_path.exists() && !overwrite_files {
            skipped.push(format!("playout/{}", name));
        } else {
            crate::atomic_fs::write_atomic(&file_path, content.as_bytes())
                .map_err(|e| format!("Failed to write template '{}': {}", file_path.display(), e))?;
            deployed.push(format!("playout/{}", name));
        }
    }

    // Also deploy the standalone advisory_default_preset.json for sidecar visibility
    if let Some(preset_val) = crate::studio_server::load_saved_default_preset(&app) {
        if let Ok(preset_json_pretty) = serde_json::to_string_pretty(&preset_val) {
            let preset_path = target_dir.join("advisory_default_preset.json");
            if crate::atomic_fs::write_atomic(&preset_path, preset_json_pretty.as_bytes()).is_ok() {
                deployed.push("playout/advisory_default_preset.json".into());
            }
        }
    }

    let deployed_preset = crate::studio_server::load_saved_default_preset(&app);
    let _ = app.emit("caspar://template-deployed", deployed_preset.as_ref());

    Ok(TemplateDeployResult {
        template_dir: target_dir.to_string_lossy().into_owned(),
        deployed,
        skipped,
    })
}

pub(crate) fn strip_verbatim_prefix(path_str: &str) -> String {
    if let Some(stripped) = path_str.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        path_str.to_string()
    }
}

#[tauri::command]
pub async fn open_cg_studio_in_browser<R: Runtime>(
    app: AppHandle<R>,
    template_path: Option<String>,
) -> Result<String, String> {
    // 1. Ensure templates are deployed to the resolved template directory
    let _ = deploy_caspar_templates(app.clone(), template_path.clone(), None, Some(true)).await;

    // 2. Resolve template target path - opens advisory.html
    let base_dir = resolve_caspar_template_dir(Some(&app), template_path.as_deref());
    let advisory_file = base_dir.join("playout").join("advisory.html");

    let resolved_file = if advisory_file.exists() {
        advisory_file
    } else {
        // Fallback to app data directory
        let fallback = dirs_next::data_dir()
            .map(|d| d.join("PlayOutVue").join("templates").join("playout").join("advisory.html"))
            .unwrap_or_else(|| PathBuf::from("./templates/playout/advisory.html"));
        if !fallback.exists() {
            if let Some(parent) = fallback.parent() {
                let _ = std::fs::create_dir_all(parent);
                let _ = std::fs::create_dir_all(parent.join("vendor"));
                let _ = std::fs::write(parent.join("vendor").join("gsap.min.js"), TEMPLATE_GSAP);
                let _ = std::fs::write(parent.join("esr_presets.json"), TEMPLATE_ESR_PRESETS);
            }
            let _ = std::fs::write(&fallback, TEMPLATE_ADVISORY);
        }
        fallback
    };

    let port = crate::studio_server::STUDIO_SERVER_PORT.load(std::sync::atomic::Ordering::Relaxed);
    let target_url = if port > 0 {
        // The per-launch bearer token travels in the URL once; the Studio
        // page reads it and attaches it to every bridge POST (audit T0-1).
        format!(
            "http://127.0.0.1:{}/studio?studio=1&token={}",
            port,
            crate::studio_server::studio_bridge_token()
        )
    } else {
        let absolute_path = std::fs::canonicalize(&resolved_file).unwrap_or(resolved_file);
        let raw_path_str = absolute_path.to_string_lossy().to_string();
        let clean_path = strip_verbatim_prefix(&raw_path_str).replace('\\', "/");
        format!("file:///{}?studio=1#studio=1", clean_path.trim_start_matches('/'))
    };

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let file_wide: Vec<u16> = target_url.encode_utf16().chain(std::iter::once(0)).collect();

        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (res as isize) <= 32 {
            return Err(format!("ShellExecuteW failed to open URL '{}' (code: {})", target_url, res as isize));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&target_url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {}", e))?;
    }

    Ok(target_url)
}

#[tauri::command]
pub async fn open_advisory_in_editor<R: Runtime>(
    app: AppHandle<R>,
    template_path: Option<String>,
) -> Result<String, String> {
    let base_dir = resolve_caspar_template_dir(Some(&app), template_path.as_deref());
    let advisory_file = base_dir.join("playout").join("advisory.html");
    let resolved_file = if advisory_file.exists() {
        advisory_file
    } else {
        dirs_next::data_dir()
            .map(|d| d.join("PlayOutVue").join("templates").join("playout").join("advisory.html"))
            .unwrap_or_else(|| PathBuf::from("./templates/playout/advisory.html"))
    };

    let absolute_path = std::fs::canonicalize(&resolved_file).unwrap_or(resolved_file);
    let raw_path_str = absolute_path.to_string_lossy().to_string();
    let clean_path = strip_verbatim_prefix(&raw_path_str);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(crate::proc_util::windows_system_tool("notepad.exe"))
            .arg(&clean_path)
            .spawn()
            .map_err(|e| format!("Failed to open editor: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&clean_path)
            .spawn()
            .map_err(|e| format!("Failed to open editor: {}", e))?;
    }

    Ok(clean_path)
}

#[tauri::command]
pub async fn open_template_directory<R: Runtime>(
    app: AppHandle<R>,
    template_path: Option<String>,
) -> Result<String, String> {
    let base_dir = resolve_caspar_template_dir(Some(&app), template_path.as_deref());
    let target_dir = base_dir.join("playout");
    let dir_to_open = if target_dir.exists() {
        target_dir
    } else if base_dir.exists() {
        base_dir
    } else {
        dirs_next::data_dir()
            .map(|d| d.join("PlayOutVue").join("templates").join("playout"))
            .unwrap_or_else(|| PathBuf::from("./templates/playout"))
    };

    let _ = std::fs::create_dir_all(&dir_to_open);
    let absolute_path = std::fs::canonicalize(&dir_to_open).unwrap_or(dir_to_open);
    let raw_path_str = absolute_path.to_string_lossy().to_string();
    let clean_path = strip_verbatim_prefix(&raw_path_str);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(crate::proc_util::windows_system_tool("explorer.exe"))
            .arg(&clean_path)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&clean_path)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }

    Ok(clean_path)
}

#[tauri::command]
pub async fn read_svg_file(path: String) -> Result<String, String> {
    // Audit T2-7: the result is injected into the on-air CG template via
    // `innerHTML`. Restrict to `.svg` files of sane size that actually look
    // like SVG; the template additionally sanitises the markup before use.
    const MAX_SVG_BYTES: u64 = 2 * 1024 * 1024;
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|_| format!("File does not exist: {}", path))?;
    if !meta.is_file() {
        return Err(format!("File does not exist: {}", path));
    }
    let is_svg_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("svg"))
        .unwrap_or(false);
    if !is_svg_ext {
        return Err(format!("Not an .svg file: {}", path));
    }
    if meta.len() > MAX_SVG_BYTES {
        return Err(format!(
            "SVG file '{}' is too large ({} bytes, limit {} bytes)",
            path, meta.len(), MAX_SVG_BYTES
        ));
    }
    let content = tauri::async_runtime::spawn_blocking(move || std::fs::read_to_string(&path))
        .await
        .map_err(|e| format!("SVG read task failed: {}", e))?
        .map_err(|e| format!("Failed to read SVG file: {}", e))?;
    if !looks_like_svg(&content) {
        return Err("File does not contain an <svg> root element".to_string());
    }
    Ok(content)
}

/// Cheap structural check: after an optional XML declaration / comments /
/// DOCTYPE, the first element must be `<svg`.
pub(crate) fn looks_like_svg(content: &str) -> bool {
    let mut rest = content.trim_start_matches('\u{feff}').trim_start();
    loop {
        if rest.starts_with("<?") {
            match rest.find("?>") {
                Some(end) => rest = rest[end + 2..].trim_start(),
                None => return false,
            }
        } else if rest.starts_with("<!--") {
            match rest.find("-->") {
                Some(end) => rest = rest[end + 3..].trim_start(),
                None => return false,
            }
        } else if rest.starts_with("<!DOCTYPE") || rest.starts_with("<!doctype") {
            match rest.find('>') {
                Some(end) => rest = rest[end + 1..].trim_start(),
                None => return false,
            }
        } else {
            break;
        }
    }
    let lower = rest.get(..4).map(|s| s.to_ascii_lowercase());
    lower.as_deref() == Some("<svg")
}

#[tauri::command]
pub async fn find_default_caspar_config<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    default_config_candidates(Some(&app))
        .into_iter()
        .find(|candidate| candidate.exists() && candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn load_caspar_config<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
) -> Result<CasparConfigLoadResult, String> {
    let resolved_path = resolve_requested_path(Some(&app), path)?;

    if !resolved_path.exists() {
        let parent_dir = resolved_path
            .parent()
            .unwrap_or_else(|| Path::new("C:/CasparCG"))
            .to_string_lossy()
            .replace('\\', "/");
        let mut config = CasparConfiguration::default();
        config.paths.media_path = Some(format!("{}/media", parent_dir));
        config.paths.data_path = Some(format!("{}/data", parent_dir));
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
pub async fn save_caspar_config_raw<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    raw_xml: String,
) -> Result<(), String> {
    let target_path = resolve_requested_path(Some(&app), Some(path))?;
    let _: CasparConfiguration = from_str(&raw_xml)
        .map_err(|error| format!("CasparCG config XML is invalid: {}", error))?;
    // Audit T1-1 (partial): never overwrite a live casparcg.config without a
    // timestamped backup, whichever save path the operator used.
    if target_path.is_file() {
        backup_config(&target_path)?;
    }
    write_config_file(&target_path, raw_xml)
}

#[tauri::command]
pub async fn save_caspar_config_structured<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    config: CasparConfiguration,
) -> Result<String, String> {
    let target_path = resolve_requested_path(Some(&app), Some(path))?;
    let xml = serialize_config(&config)?;
    // Audit T1-1 (partial): the typed round-trip drops XML elements the model
    // does not know (see AUDIT-PLAN T1-1). Until in-place patching lands, a
    // backup guarantees the operator can restore the original.
    if target_path.is_file() {
        backup_config(&target_path)?;
    }
    write_config_file(&target_path, xml.clone())?;
    Ok(xml)
}

#[tauri::command]
pub async fn apply_caspar_decklink_config<R: Runtime>(
    app: AppHandle<R>,
    payload: DeckLinkApplyPayload,
) -> Result<DeckLinkApplyResult, String> {
    let target_path = resolve_requested_path(Some(&app), Some(payload.path))?;
    let mut config = if target_path.exists() {
        let raw_xml = std::fs::read_to_string(&target_path)
            .map_err(|error| format!("Failed to read CasparCG config '{}': {}", target_path.display(), error))?;
        from_str::<CasparConfiguration>(&raw_xml)
            .map_err(|error| format!("Failed to parse CasparCG config '{}': {}", target_path.display(), error))?
    } else {
        CasparConfiguration::default()
    };

    // Audit T2-15: `channel_index` comes from the WebView. Without a bound a
    // huge value would allocate that many default channels (OOM) and write a
    // config CasparCG cannot start. CasparCG itself supports a handful of
    // channels; 16 is far beyond any real deployment.
    const MAX_CHANNEL_INDEX: usize = 15;
    if payload.channel_index > MAX_CHANNEL_INDEX {
        return Err(format!(
            "Channel index {} is out of range (maximum {})",
            payload.channel_index, MAX_CHANNEL_INDEX
        ));
    }
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
    if payload.enable_screen_consumer.unwrap_or(true)
        && channel.consumers.screens.is_empty() {
            channel.consumers.screens = vec![CasparScreenConsumer::default()];
        }

    // Ensure system audio consumer is present
    if channel.consumers.system_audio.is_empty() {
        channel.consumers.system_audio = vec![CasparSystemAudioConsumer::default()];
    }

    // Ensure OSC default port 6250 is configured
    if config.osc.is_none() {
        config.osc = Some(CasparOsc::default());
    }

    // Optional media path configuration
    if let Some(ref mp) = payload.media_path {
        let trimmed = mp.trim();
        if !trimmed.is_empty() {
            let mut normalized = trimmed.replace('\\', "/");
            if !normalized.ends_with('/') {
                normalized.push('/');
            }
            config.paths.media_path = Some(normalized);
        }
    }

    // Optional template deployment
    let mut templates_deployed = None;
    if payload.deploy_templates.unwrap_or(true) {
        let template_base = payload.template_path
            .clone()
            .or_else(|| config.paths.template_path.clone())
            .unwrap_or_else(|| "C:/CasparCG/template/".to_string());

        let media_base = config.paths.media_path.clone();
        if let Ok(res) = deploy_caspar_templates(app.clone(), Some(template_base), media_base, Some(true)).await {
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
    crate::atomic_fs::write_atomic(path, contents.as_bytes())
        .map_err(|error| format!("Failed to write config '{}': {}", path.display(), error))
}

fn write_config_file(path: &Path, contents: String) -> Result<(), String> {
    write_config_file_atomic(path, contents)
}

fn serialize_config(config: &CasparConfiguration) -> Result<String, String> {
    let body = to_string(config).map_err(|error| format!("Failed to serialize CasparCG config: {}", error))?;
    Ok(format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}\n", body))
}

fn resolve_requested_path<R: Runtime>(app: Option<&AppHandle<R>>, path: Option<String>) -> Result<PathBuf, String> {
    let trimmed = path.unwrap_or_default().trim().to_string();
    if !trimmed.is_empty() {
        return Ok(PathBuf::from(trimmed));
    }

    if let Some(found) = find_default_caspar_config_blocking(app) {
        return Ok(found);
    }

    if let Some(app) = app {
        if let Some(runtime_state) = app.try_state::<crate::runtime_settings::RuntimeSettingsState>() {
            let snapshot = runtime_state.snapshot();
            if !snapshot.casparcg_executable_path.is_empty() {
                let exe_p = PathBuf::from(&snapshot.casparcg_executable_path);
                let parent = if exe_p.is_file() || snapshot.casparcg_executable_path.to_lowercase().ends_with(".exe") {
                    exe_p.parent().map(|p| p.to_path_buf())
                } else {
                    Some(exe_p)
                };
                if let Some(p) = parent {
                    let cfg_name = if !snapshot.casparcg_config_filename.is_empty() {
                        snapshot.casparcg_config_filename.as_str()
                    } else {
                        "casparcg.config"
                    };
                    return Ok(p.join(cfg_name));
                }
            }
        }
    }

    Ok(PathBuf::from("C:/CasparCG/casparcg.config"))
}

fn find_default_caspar_config_blocking<R: Runtime>(app: Option<&AppHandle<R>>) -> Option<PathBuf> {
    default_config_candidates(app)
        .into_iter()
        .find(|candidate| candidate.exists() && candidate.is_file())
}

fn default_config_candidates<R: Runtime>(app: Option<&AppHandle<R>>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(app) = app {
        if let Some(runtime_state) = app.try_state::<crate::runtime_settings::RuntimeSettingsState>() {
            let snapshot = runtime_state.snapshot();
            if !snapshot.casparcg_executable_path.is_empty() {
                let exe_p = PathBuf::from(&snapshot.casparcg_executable_path);
                let parent = if exe_p.is_file() || snapshot.casparcg_executable_path.to_lowercase().ends_with(".exe") {
                    exe_p.parent().map(|p| p.to_path_buf())
                } else {
                    Some(exe_p)
                };
                if let Some(p) = parent {
                    let cfg_name = if !snapshot.casparcg_config_filename.is_empty() {
                        snapshot.casparcg_config_filename.as_str()
                    } else {
                        "casparcg.config"
                    };
                    candidates.push(p.join(cfg_name));
                    if cfg_name != "casparcg.config" {
                        candidates.push(p.join("casparcg.config"));
                    }
                }
            }
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decklink_apply_payload_deserializes_from_camel_case() {
        let json_str = r#"{
            "path": "C:/CasparCG/casparcg.config",
            "channelIndex": 0,
            "outputDevice": 2,
            "keyDevice": 3,
            "embeddedAudio": true,
            "bufferDepth": 4,
            "latency": "low",
            "keyer": "internal",
            "videoMode": "1080p2500",
            "enableScreenConsumer": false,
            "deployTemplates": true,
            "templatePath": "C:/CasparCG/template",
            "mediaPath": "D:/CasparMedia"
        }"#;

        let payload: DeckLinkApplyPayload = serde_json::from_str(json_str).expect("Must deserialize camelCase");
        assert_eq!(payload.path, "C:/CasparCG/casparcg.config");
        assert_eq!(payload.channel_index, 0);
        assert_eq!(payload.output_device, 2);
        assert_eq!(payload.key_device, Some(3));
        assert_eq!(payload.embedded_audio, Some(true));
        assert_eq!(payload.buffer_depth, Some(4));
        assert_eq!(payload.latency.as_deref(), Some("low"));
        assert_eq!(payload.keyer.as_deref(), Some("internal"));
        assert_eq!(payload.video_mode.as_deref(), Some("1080p2500"));
        assert_eq!(payload.enable_screen_consumer, Some(false));
        assert_eq!(payload.deploy_templates, Some(true));
        assert_eq!(payload.template_path.as_deref(), Some("C:/CasparCG/template"));
        assert_eq!(payload.media_path.as_deref(), Some("D:/CasparMedia"));
    }

    #[test]
    fn test_decklink_apply_payload_deserializes_from_snake_case() {
        let json_str = r#"{
            "path": "C:/CasparCG/casparcg.config",
            "channel_index": 1,
            "output_device": 1,
            "key_device": null,
            "embedded_audio": false,
            "buffer_depth": 3,
            "latency": "normal",
            "keyer": "external",
            "video_mode": "1080i5000",
            "enable_screen_consumer": true,
            "deploy_templates": false,
            "template_path": null,
            "media_path": "E:/Media/"
        }"#;

        let payload: DeckLinkApplyPayload = serde_json::from_str(json_str).expect("Must deserialize snake_case");
        assert_eq!(payload.channel_index, 1);
        assert_eq!(payload.output_device, 1);
        assert_eq!(payload.key_device, None);
        assert_eq!(payload.embedded_audio, Some(false));
        assert_eq!(payload.buffer_depth, Some(3));
        assert_eq!(payload.enable_screen_consumer, Some(true));
        assert_eq!(payload.deploy_templates, Some(false));
        assert_eq!(payload.media_path.as_deref(), Some("E:/Media/"));
    }

    #[test]
    fn test_decklink_apply_payload_defaults() {
        let json_str = r#"{}"#;
        let payload: DeckLinkApplyPayload = serde_json::from_str(json_str).expect("Must deserialize empty object with defaults");
        assert_eq!(payload.path, "");
        assert_eq!(payload.channel_index, 0);
        assert_eq!(payload.output_device, 1);
        assert_eq!(payload.key_device, None);
        assert_eq!(payload.embedded_audio, None);
        assert_eq!(payload.buffer_depth, None);
        assert_eq!(payload.latency, None);
        assert_eq!(payload.keyer, None);
        assert_eq!(payload.video_mode, None);
        assert_eq!(payload.enable_screen_consumer, None);
        assert_eq!(payload.deploy_templates, None);
        assert_eq!(payload.template_path, None);
        assert_eq!(payload.media_path, None);
    }

    #[test]
    fn test_caspar_config_deserializes_with_aliases() {
        let json_str = r#"{
            "paths": {
                "media_path": "D:/MyPlayoutMedia",
                "dataPath": "D:/MyPlayoutData"
            },
            "channels": {
                "channel": [
                    {
                        "videoMode": "1080i5000",
                        "consumers": {
                            "decklink": [
                                {
                                    "device": 2,
                                    "keyDevice": 3,
                                    "embeddedAudio": true,
                                    "bufferDepth": 4
                                }
                            ]
                        }
                    }
                ]
            }
        }"#;

        let config: CasparConfiguration = serde_json::from_str(json_str).expect("Must deserialize with aliases");
        assert_eq!(config.paths.media_path.as_deref(), Some("D:/MyPlayoutMedia"));
        assert_eq!(config.paths.data_path.as_deref(), Some("D:/MyPlayoutData"));
        assert_eq!(config.channels.channels.len(), 1);
        assert_eq!(config.channels.channels[0].video_mode.as_deref(), Some("1080i5000"));
        assert_eq!(config.channels.channels[0].consumers.decklinks.len(), 1);
        assert_eq!(config.channels.channels[0].consumers.decklinks[0].device, Some(2));
        assert_eq!(config.channels.channels[0].consumers.decklinks[0].key_device, Some(3));
        assert_eq!(config.channels.channels[0].consumers.decklinks[0].embedded_audio, Some(true));
        assert_eq!(config.channels.channels[0].consumers.decklinks[0].buffer_depth, Some(4));
    }

    #[test]
    fn test_strip_verbatim_prefix() {
        assert_eq!(super::strip_verbatim_prefix(r"\\?\D:\PlayOut\templates"), r"D:\PlayOut\templates");
        assert_eq!(super::strip_verbatim_prefix(r"\\?\UNC\server\share\file.html"), r"\\server\share\file.html");
        assert_eq!(super::strip_verbatim_prefix(r"D:\normal\path"), r"D:\normal\path");
    }
}