use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{Path as AxPath, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::time::{sleep, Duration};
use uuid::Uuid;
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Parser, Debug)]
#[command(name = "playout-ingestd", version, about = "PlayOutVue media ingestor service")]
struct Cli {
    #[arg(long, value_name = "DIR")]
    ffmpeg_bin: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Migrate {
        #[arg(long, value_name = "DIR")]
        source: PathBuf,
        #[arg(long, value_name = "DIR")]
        dest: PathBuf,
        #[arg(long, default_value_t = false)]
        auto_trim_black: bool,
    },
    Serve {
        #[arg(long, default_value_t = 8088)]
        port: u16,
        #[arg(long, value_name = "DIR")]
        dest: PathBuf,
        #[arg(long, default_value_t = false)]
        auto_trim_black: bool,
        #[arg(long, value_name = "DIR")]
        watch_folder: Option<PathBuf>,
        #[arg(long, default_value_t = 2)]
        max_concurrency: usize,
        #[arg(long, default_value_t = 2)]
        ffmpeg_threads: usize,
        #[arg(long, default_value_t = 5)]
        poll_secs: u64,
        #[arg(long, default_value_t = 5)]
        settle_secs: u64,
        #[arg(long, default_value = "")]
        include_ext: String,
        #[arg(long, default_value = "")]
        exclude_ext: String,
        #[arg(long, value_enum, default_value_t = DuplicatePolicy::Skip)]
        duplicate_policy: DuplicatePolicy,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "camelCase")]
enum DuplicatePolicy {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Debug, Clone)]
struct ToolPaths {
    ffprobe: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
enum MediaState {
    Compliant,
    RequiresTranscode,
}

#[derive(Debug, Clone)]
struct ProbeResult {
    media_state: MediaState,
    duration_secs: f64,
    video_codec: String,
    audio_codec: String,
    fps: f64,
    cfr_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrimData {
    trim_in: Option<f64>,
    trim_out: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessOutcome {
    input_path: String,
    output_path: String,
    playout_id: String,
    media_state: MediaState,
    auto_trim_enabled: bool,
    applied_trim: Option<TrimData>,
    duration_secs: f64,
    summary: String,
}

#[derive(Debug, Clone)]
struct StageUpdate {
    stage: String,
    progress: Option<f32>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<StreamInfo>,
    format: FormatInfo,
}

#[derive(Debug, Deserialize)]
struct StreamInfo {
    codec_type: String,
    codec_name: Option<String>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FormatInfo {
    duration: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IngestJobStatus {
    id: String,
    input_path: String,
    output_path: Option<String>,
    stage: String,
    message: String,
    progress: f32,
    done: bool,
    success: bool,
    error: Option<String>,
    media_state: Option<MediaState>,
    started_at_ms: u64,
    finished_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestRequest {
    file_path: String,
    auto_trim: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestAccepted {
    job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
}

#[derive(Clone)]
struct ApiState {
    tools: ToolPaths,
    destination_root: PathBuf,
    default_auto_trim: bool,
    watch_folder: Option<PathBuf>,
    max_concurrency: usize,
    ffmpeg_threads: usize,
    poll_secs: u64,
    settle_secs: u64,
    include_extensions: Vec<String>,
    exclude_extensions: Vec<String>,
    duplicate_policy: DuplicatePolicy,
    semaphore: Arc<Semaphore>,
    jobs: Arc<Mutex<HashMap<String, IngestJobStatus>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiConfigResponse {
    destination_root: String,
    watch_folder: Option<String>,
    default_auto_trim: bool,
    max_concurrency: usize,
    ffmpeg_threads: usize,
    poll_secs: u64,
    settle_secs: u64,
    include_extensions: Vec<String>,
    exclude_extensions: Vec<String>,
    duplicate_policy: DuplicatePolicy,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let tools = resolve_tool_paths(cli.ffmpeg_bin.as_deref())?;

    match cli.command {
        Commands::Migrate {
            source,
            dest,
            auto_trim_black,
        } => run_migrate(&tools, &source, &dest, auto_trim_black),
        Commands::Serve {
            port,
            dest,
            auto_trim_black,
            watch_folder,
            max_concurrency,
            ffmpeg_threads,
            poll_secs,
            settle_secs,
            include_ext,
            exclude_ext,
            duplicate_policy,
        } => {
            run_server(
                tools,
                dest,
                port,
                auto_trim_black,
                watch_folder,
                max_concurrency,
                ffmpeg_threads,
                poll_secs,
                settle_secs,
                include_ext,
                exclude_ext,
                duplicate_policy,
            )
            .await
        }
    }
}

fn run_migrate(tools: &ToolPaths, source: &Path, dest: &Path, auto_trim_black: bool) -> Result<()> {
    let _ = (tools, source, dest, auto_trim_black);
    bail!(
        "Migrate mode has been removed from PlayOut ingestd. Use FFAStrans for re-encoding and keep ingestd for metadata validation only."
    )
}

async fn run_server(
    tools: ToolPaths,
    destination_root: PathBuf,
    port: u16,
    default_auto_trim: bool,
    watch_folder: Option<PathBuf>,
    max_concurrency: usize,
    ffmpeg_threads: usize,
    poll_secs: u64,
    settle_secs: u64,
    include_ext: String,
    exclude_ext: String,
    duplicate_policy: DuplicatePolicy,
) -> Result<()> {
    fs::create_dir_all(&destination_root).with_context(|| {
        format!(
            "Failed to create ingest destination root {}",
            destination_root.display()
        )
    })?;

    if let Some(folder) = &watch_folder {
        if !folder.is_dir() {
            bail!("Watch folder does not exist: {}", folder.display());
        }
    }

    let bounded_concurrency = max_concurrency.max(1);
    let bounded_threads = ffmpeg_threads.max(1);
    let include_extensions = parse_extension_list(&include_ext);
    let exclude_extensions = parse_extension_list(&exclude_ext);

    let app_state = ApiState {
        tools,
        destination_root,
        default_auto_trim,
        watch_folder,
        max_concurrency: bounded_concurrency,
        ffmpeg_threads: bounded_threads,
        poll_secs,
        settle_secs,
        include_extensions,
        exclude_extensions,
        duplicate_policy,
        semaphore: Arc::new(Semaphore::new(bounded_concurrency)),
        jobs: Arc::new(Mutex::new(HashMap::new())),
    };

    if let Some(watch_root) = app_state.watch_folder.clone() {
        let watch_state = app_state.clone();
        tokio::spawn(async move {
            run_watchfolder_loop(watch_state, watch_root).await;
        });
    }

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(get_config))
        .route("/api/ingest", post(start_ingest))
        .route("/api/ingest/:job_id", get(get_ingest_status))
        .with_state(app_state);

    let address = format!("0.0.0.0:{port}");
    println!("[serve] playout-ingestd listening on http://{}", address);

    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .with_context(|| format!("Failed to bind on {}", address))?;

    axum::serve(listener, app)
        .await
        .context("Ingest API server terminated unexpectedly")
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn get_config(State(state): State<ApiState>) -> Json<ApiConfigResponse> {
    Json(ApiConfigResponse {
        destination_root: state.destination_root.to_string_lossy().into_owned(),
        watch_folder: state
            .watch_folder
            .as_ref()
            .map(|value| value.to_string_lossy().into_owned()),
        default_auto_trim: state.default_auto_trim,
        max_concurrency: state.max_concurrency,
        ffmpeg_threads: state.ffmpeg_threads,
        poll_secs: state.poll_secs,
        settle_secs: state.settle_secs,
        include_extensions: state.include_extensions.clone(),
        exclude_extensions: state.exclude_extensions.clone(),
        duplicate_policy: state.duplicate_policy,
    })
}

async fn enqueue_ingest_job(
    state: &ApiState,
    input_path: PathBuf,
    _auto_trim: bool,
) -> Result<String> {
    let job_id = Uuid::new_v4().to_string();

    let job = IngestJobStatus {
        id: job_id.clone(),
        input_path: input_path.to_string_lossy().into_owned(),
        output_path: None,
        stage: "Queued".to_string(),
        message: "Job queued".to_string(),
        progress: 0.0,
        done: false,
        success: false,
        error: None,
        media_state: None,
        started_at_ms: now_ms(),
        finished_at_ms: 0,
    };

    update_job(&state.jobs, job);

    let jobs = state.jobs.clone();
    let tools = state.tools.clone();
    let worker_job_id = job_id.clone();
    let semaphore = state.semaphore.clone();

    tokio::spawn(async move {
        let Ok(permit) = semaphore.acquire_owned().await else {
            mark_job_failed(&jobs, &worker_job_id, anyhow!("Failed to acquire worker permit"));
            return;
        };

        set_job_stage(
            &jobs,
            &worker_job_id,
            "Starting",
            "Starting metadata validation",
            0.0,
            None,
            false,
            false,
            None,
        );

        let jobs_for_worker = jobs.clone();
        let worker_id = worker_job_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            process_one_file(
                &tools,
                &input_path,
                |update| {
                    let progress = update.progress.unwrap_or(0.0);
                    set_job_stage(
                        &jobs_for_worker,
                        &worker_id,
                        &update.stage,
                        &update.message,
                        progress,
                        None,
                        false,
                        false,
                        None,
                    );
                },
            )
        })
        .await;

        match result {
            Ok(Ok(outcome)) => {
                set_job_stage(
                    &jobs,
                    &worker_job_id,
                    "Done",
                    &outcome.summary,
                    100.0,
                    Some(outcome.media_state),
                    true,
                    true,
                    None,
                );
            }
            Ok(Err(error)) => {
                mark_job_failed(&jobs, &worker_job_id, error);
            }
            Err(error) => {
                mark_job_failed(
                    &jobs,
                    &worker_job_id,
                    anyhow!("Ingest worker join failed: {}", error),
                );
            }
        }

        drop(permit);
    });

    Ok(job_id)
}

async fn start_ingest(
    State(state): State<ApiState>,
    Json(request): Json<IngestRequest>,
) -> impl IntoResponse {
    let input_path = PathBuf::from(request.file_path.trim());
    if request.file_path.trim().is_empty() || !input_path.is_file() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "file_path must point to an existing file"
            })),
        );
    }

    if !is_path_allowed_by_extension(&input_path, &state.include_extensions, &state.exclude_extensions)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "input file extension is not allowed by current include/exclude filters"
            })),
        );
    }

    let auto_trim = request.auto_trim.unwrap_or(state.default_auto_trim);

    match enqueue_ingest_job(&state, input_path, auto_trim).await {
        Ok(job_id) => (StatusCode::ACCEPTED, Json(serde_json::json!(IngestAccepted { job_id }))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": error.to_string() })),
        ),
    }
}

async fn get_ingest_status(
    State(state): State<ApiState>,
    AxPath(job_id): AxPath<String>,
) -> impl IntoResponse {
    let snapshot = match state.jobs.lock() {
        Ok(guard) => guard.get(&job_id).cloned(),
        Err(_) => None,
    };

    if let Some(status) = snapshot {
        (StatusCode::OK, Json(serde_json::json!(status))).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "job not found"})),
        )
            .into_response()
    }
}

async fn run_watchfolder_loop(state: ApiState, watch_root: PathBuf) {
    let mut previous_identity: HashMap<PathBuf, (u64, u64)> = HashMap::new();
    let mut queued_identity: HashMap<PathBuf, (u64, u64)> = HashMap::new();

    loop {
        let snapshot = collect_watch_candidates(&watch_root);

        for (path, identity, modified_epoch_secs) in &snapshot {
            if !is_path_allowed_by_extension(path, &state.include_extensions, &state.exclude_extensions) {
                continue;
            }

            let was_seen_unchanged = previous_identity
                .get(path)
                .map(|value| value == identity)
                .unwrap_or(false);

            if !was_seen_unchanged {
                continue;
            }

            let age_secs = current_epoch_secs().saturating_sub(*modified_epoch_secs);
            if age_secs < state.settle_secs {
                continue;
            }

            let already_queued_for_identity = queued_identity
                .get(path)
                .map(|value| value == identity)
                .unwrap_or(false);
            if already_queued_for_identity {
                continue;
            }

            if has_active_job_for_input(&state.jobs, path) {
                continue;
            }

            let enqueue = enqueue_ingest_job(&state, path.clone(), state.default_auto_trim).await;

            match enqueue {
                Ok(_) => {
                    queued_identity.insert(path.clone(), *identity);
                }
                Err(error) => {
                    eprintln!("[watch] failed to enqueue {}: {}", path.display(), error);
                }
            }
        }

        previous_identity.clear();
        for (path, identity, _) in snapshot {
            previous_identity.insert(path, identity);
        }

        sleep(Duration::from_secs(state.poll_secs.max(1))).await;
    }
}

fn collect_watch_candidates(root: &Path) -> Vec<(PathBuf, (u64, u64), u64)> {
    let mut candidates = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Ok(metadata) = fs::metadata(path) else {
            continue;
        };

        let size = metadata.len();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);

        candidates.push((path.to_path_buf(), (modified, size), modified));
    }

    candidates
}

fn has_active_job_for_input(
    jobs: &Arc<Mutex<HashMap<String, IngestJobStatus>>>,
    input_path: &Path,
) -> bool {
    let input_normalized = input_path.to_string_lossy().replace('\\', "/");

    let Ok(guard) = jobs.lock() else {
        return false;
    };

    guard.values().any(|job| {
        !job.done && job.input_path.replace('\\', "/") == input_normalized
    })
}

fn process_one_file(
    tools: &ToolPaths,
    input_path: &Path,
    mut on_update: impl FnMut(StageUpdate),
) -> Result<ProcessOutcome> {
    on_update(StageUpdate {
        stage: "Probing...".to_string(),
        progress: None,
        message: format!("Probing {}", input_path.display()),
    });

    let probe = evaluate_media(tools, input_path)?;

    let summary = match probe.media_state {
        MediaState::Compliant => format!(
            "Validation passed: codec={} audio={} fps={:.3} duration={:.3}s",
            probe.video_codec,
            probe.audio_codec,
            probe.fps,
            probe.duration_secs
        ),
        MediaState::RequiresTranscode => format!(
            "Validation warning: codec={} audio={} fps={:.3} cfr={} duration={:.3}s. Normalize with FFAStrans.",
            probe.video_codec,
            probe.audio_codec,
            probe.fps,
            probe.cfr_ok,
            probe.duration_secs
        ),
    };

    on_update(StageUpdate {
        stage: "Validating...".to_string(),
        progress: Some(50.0),
        message: "Checking duration and PAL/CasparCG format integrity".to_string(),
    });

    on_update(StageUpdate {
        stage: "Finalizing...".to_string(),
        progress: Some(100.0),
        message: "Validation complete".to_string(),
    });

    Ok(ProcessOutcome {
        input_path: input_path.to_string_lossy().into_owned(),
        output_path: input_path.to_string_lossy().into_owned(),
        playout_id: String::new(),
        media_state: probe.media_state,
        auto_trim_enabled: false,
        applied_trim: None,
        duration_secs: probe.duration_secs,
        summary,
    })
}

fn evaluate_media(tools: &ToolPaths, input_path: &Path) -> Result<ProbeResult> {
    let mut command = Command::new(&tools.ffprobe);
    command.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
    ]);
    command.arg(input_path);

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .with_context(|| format!("Failed to run ffprobe on {}", input_path.display()))?;

    if !output.status.success() {
        bail!(
            "ffprobe failed for {}: {}",
            input_path.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("Failed to parse ffprobe JSON for {}", input_path.display()))?;

    let video_stream = parsed.streams.iter().find(|stream| stream.codec_type == "video");
    let audio_stream = parsed.streams.iter().find(|stream| stream.codec_type == "audio");

    let video_codec = video_stream
        .and_then(|stream| stream.codec_name.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let audio_codec = audio_stream
        .and_then(|stream| stream.codec_name.clone())
        .unwrap_or_else(|| "none".to_string());

    let fps = video_stream
        .and_then(|stream| stream.avg_frame_rate.as_deref().and_then(parse_ratio).or_else(|| stream.r_frame_rate.as_deref().and_then(parse_ratio)))
        .unwrap_or(0.0);

    let video_codec_ok = video_stream
        .and_then(|stream| stream.codec_name.as_deref())
        .map(|codec| codec.eq_ignore_ascii_case("h264"))
        .unwrap_or(false);

    let audio_codec_ok = audio_stream
        .and_then(|stream| stream.codec_name.as_deref())
        .map(|codec| codec.to_ascii_lowercase().starts_with("pcm_"))
        .unwrap_or(false);

    let cfr_ok = video_stream.map(is_cfr_stream).unwrap_or(false);

    let duration_secs = parsed
        .format
        .duration
        .as_deref()
        .and_then(parse_float)
        .or_else(|| video_stream.and_then(|stream| stream.duration.as_deref()).and_then(parse_float))
        .or_else(|| audio_stream.and_then(|stream| stream.duration.as_deref()).and_then(parse_float))
        .unwrap_or(0.0);

    let media_state = if video_codec_ok && audio_codec_ok && cfr_ok {
        MediaState::Compliant
    } else {
        MediaState::RequiresTranscode
    };

    Ok(ProbeResult {
        media_state,
        duration_secs,
        video_codec,
        audio_codec,
        fps,
        cfr_ok,
    })
}

fn is_cfr_stream(stream: &StreamInfo) -> bool {
    let r = stream
        .r_frame_rate
        .as_deref()
        .and_then(parse_ratio)
        .unwrap_or(0.0);
    let avg = stream
        .avg_frame_rate
        .as_deref()
        .and_then(parse_ratio)
        .unwrap_or(0.0);

    if r <= 0.0 || avg <= 0.0 {
        return false;
    }

    (r - avg).abs() <= 0.02
}

fn parse_ratio(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "0/0" {
        return None;
    }

    if let Some((num, den)) = trimmed.split_once('/') {
        let num = num.trim().parse::<f64>().ok()?;
        let den = den.trim().parse::<f64>().ok()?;
        if den.abs() < f64::EPSILON {
            return None;
        }
        let ratio = num / den;
        return if ratio.is_finite() && ratio > 0.0 {
            Some(ratio)
        } else {
            None
        };
    }

    parse_float(trimmed)
}

fn parse_float(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if parsed.is_finite() && parsed >= 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn is_supported_media_file(path: &Path) -> bool {
    let extension = extension_lowercase(path);

    matches!(
        extension.as_str(),
        "mp4" | "mov" | "mxf" | "mkv" | "avi" | "webm" | "ts" | "m2ts"
    )
}

fn extension_lowercase(path: &Path) -> String {
    path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .unwrap_or_default()
}

fn parse_extension_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn is_path_allowed_by_extension(path: &Path, include: &[String], exclude: &[String]) -> bool {
    if !is_supported_media_file(path) {
        return false;
    }

    let ext = extension_lowercase(path);
    if ext.is_empty() {
        return false;
    }

    if exclude.iter().any(|entry| entry == &ext) {
        return false;
    }

    if include.is_empty() {
        return true;
    }

    include.iter().any(|entry| entry == &ext)
}

fn resolve_tool_paths(ffmpeg_bin: Option<&Path>) -> Result<ToolPaths> {
    Ok(ToolPaths {
        ffprobe: resolve_tool("ffprobe", ffmpeg_bin),
    })
}

fn resolve_tool(name: &str, ffmpeg_bin: Option<&Path>) -> PathBuf {
    let tool_name = executable_name(name);
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(bin) = ffmpeg_bin {
        candidates.push(bin.join(&tool_name));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("Requirements").join("ffmpeg").join("bin").join(&tool_name));
        if let Some(parent) = cwd.parent() {
            candidates.push(
                parent
                    .join("Requirements")
                    .join("ffmpeg")
                    .join("bin")
                    .join(&tool_name),
            );
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(
                exe_dir
                    .join("Requirements")
                    .join("ffmpeg")
                    .join("bin")
                    .join(&tool_name),
            );
            candidates.push(exe_dir.join("ffmpeg").join("bin").join(&tool_name));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(tool_name))
}

fn executable_name(base: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{base}.exe")
    }

    #[cfg(not(target_os = "windows"))]
    {
        base.to_string()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn current_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn update_job(jobs: &Arc<Mutex<HashMap<String, IngestJobStatus>>>, status: IngestJobStatus) {
    if let Ok(mut guard) = jobs.lock() {
        guard.insert(status.id.clone(), status);
    }
}

fn set_job_stage(
    jobs: &Arc<Mutex<HashMap<String, IngestJobStatus>>>,
    job_id: &str,
    stage: &str,
    message: &str,
    progress: f32,
    media_state: Option<MediaState>,
    done: bool,
    success: bool,
    error: Option<String>,
) {
    if let Ok(mut guard) = jobs.lock() {
        if let Some(job) = guard.get_mut(job_id) {
            job.stage = stage.to_string();
            job.message = message.to_string();
            job.progress = progress;
            if media_state.is_some() {
                job.media_state = media_state;
            }
            job.done = done;
            job.success = success;
            job.error = error;
            if done {
                job.finished_at_ms = now_ms();
            }
        }
    }
}

fn mark_job_failed(jobs: &Arc<Mutex<HashMap<String, IngestJobStatus>>>, job_id: &str, error: anyhow::Error) {
    set_job_stage(
        jobs,
        job_id,
        "Failed",
        "Ingest failed",
        100.0,
        None,
        true,
        false,
        Some(error.to_string()),
    );
}
