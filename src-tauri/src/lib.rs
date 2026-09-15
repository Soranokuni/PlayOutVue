mod atomic_fs;
mod proc_util;
mod scanner;
mod stream;
mod trimmer;
mod playlist;
mod db;
mod diagnostics;
mod runtime_settings;
mod media_server;
mod media_index;
mod caspar;
mod caspar_layers;
mod amcp;
mod caspar_config;
mod filesystem;
mod ingestor_api;
mod transcoder_sidecar;
mod caspar_process;
mod studio_server;

use studio_server::{save_studio_default_preset, get_studio_default_preset};

use caspar::{caspar_send_command, configure_caspar_osc_listener, prepare_caspar_media_path, CasparOscListenerState, caspar_cg_add, caspar_cg_update, caspar_cg_play, caspar_cg_stop, caspar_play_image, caspar_clear_layer, caspar_register_playback, caspar_clear_playback, caspar_clear_playback_if_uuid, caspar_set_playback_paused, CasparPlaybackState};
use amcp::AmcpClient;
use caspar_process::{
    caspar_process_adopt, caspar_process_check_port, caspar_process_get_status, caspar_process_restart,
    caspar_process_start, caspar_process_stop, caspar_process_validate_path,
    CasparProcessSupervisor, DEFAULT_AMCP_PORT,
};
use caspar_config::{apply_caspar_decklink_config, caspar_test_connection, deploy_caspar_templates, find_default_caspar_config, load_caspar_config, open_advisory_in_editor, open_cg_studio_in_browser, open_template_directory, read_svg_file, save_caspar_config_raw, save_caspar_config_structured};
use diagnostics::{clear_diagnostic_logs, export_diagnostic_logs, get_diagnostic_logs, push_diagnostic_log, redact_path_for_diagnostics, DiagnosticState, init_background_logger};
use tauri::Manager;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use runtime_settings::{apply_runtime_settings, RuntimeSettingsState};
use scanner::{get_media_probe_status, save_media_trim_profile, scan_media, scan_directory, start_media_probe, warm_media_cache, DbState, MediaProbeState};
use stream::extract_web_stream;
use trimmer::{get_media_preview_info, get_media_preview_url, compute_frame_trim, parse_timecode};
use playlist::{save_playlist, load_playlist};
use filesystem::{browse_filesystem, find_default_logos_dir, get_image_dimensions, list_filesystem_roots};
use ingestor_api::{
    auto_purge_ingestor_recycle_bin, check_ingestor_health, create_ingestor_subclip,
    list_ingestor_assets, list_ingestor_folder_colors, list_ingestor_recycle_bin,
    move_ingestor_asset, purge_ingestor_asset, purge_ingestor_folder, purge_ingestor_recycle_bin,
    rename_ingestor_asset, resolve_ingestor_asset, resolve_ingestor_assets_batch,
    restore_ingestor_asset, restore_ingestor_folder, set_ingestor_folder_color,
    spawn_ingestor_heartbeat, trash_ingestor_asset, trash_ingestor_folder, update_ingestor_rating,
    update_ingestor_tp, update_ingestor_trim,
};
use transcoder_sidecar::verify_playback_ready;
use db::{MediaDb, default_db_path};

/// Return an HTTP URL that streams a local file to <video src="…">
/// No memory pressure — the media_server streams in 64 KB chunks.
#[tauri::command]
fn get_media_url(path: String) -> String {
    media_server::url_for(&path)
}

/// Startup-time error reporting that is safe in a `windows_subsystem = "windows"`
/// binary: `eprintln!` panics if stderr is a closed pipe, which would abort
/// the on-air app on a harmless warning. Writes to the log facade (once the
/// plugin is up) and best-effort to stderr.
fn startup_error(message: &str) {
    log::error!("{}", message);
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "[PlayOut] {}", message);
}

/// Audit T1-6: capture every panic into a crash report file and the log
/// before the default hook runs. With `panic = "unwind"` the process keeps
/// running for panics inside spawned tasks; for a panic on the main thread
/// this still guarantees a post-mortem artefact exists.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let report = format!(
            "PlayOut panic\ntime: {}\nthread: {}\nlocation: {}\nmessage: {}\n\nbacktrace:\n{}\n",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            thread.name().unwrap_or("<unnamed>"),
            info.location().map(|l| l.to_string()).unwrap_or_default(),
            info.payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string()),
            std::backtrace::Backtrace::force_capture()
        );
        log::error!("{}", report);
        diagnostics::push_caspar_process_log("PANIC", &report);
        if let Some(mut dir) = dirs_next::data_dir() {
            dir.push("com.playout.client");
            dir.push("crash-reports");
            let _ = std::fs::create_dir_all(&dir);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = std::fs::write(dir.join(format!("panic-{}.txt", stamp)), report.as_bytes());
        }
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    // Start the local media streaming server (async, random port, no memory overhead)
    let _media_server_runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => {
            if let Err(error) = rt.block_on(media_server::start()) {
                startup_error(&format!("Media server disabled: {}", error));
                None
            } else {
                Some(rt)
            }
        }
        Err(error) => {
            startup_error(&format!("Failed to start bootstrap runtime for media server: {}", error));
            None
        }
    };

    // Open (or create) the SQLite media metadata cache
    let db_path = default_db_path();
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let media_db = match MediaDb::open(&db_path) {
        Ok(db) => db,
        Err(error) => {
            startup_error(&format!("Media DB open failed: {}. Using in-memory fallback.", error));
            match MediaDb::open(std::path::Path::new(":memory:")) {
                Ok(memory_db) => memory_db,
                Err(memory_error) => {
                    startup_error(&format!("In-memory media DB fallback failed: {}. Media cache disabled.", memory_error));
                    MediaDb::disabled(format!("Media cache unavailable: {}; fallback failed: {}", error, memory_error))
                }
            }
        }
    };
    let settings_state = RuntimeSettingsState::default();
    let debug_enabled = settings_state.snapshot().debug_enabled;
    let diagnostics = DiagnosticState::default();
    diagnostics.set_enabled(debug_enabled);
    let supervisor = CasparProcessSupervisor::new(DEFAULT_AMCP_PORT);
    let amcp_client = AmcpClient::new();
    if !supervisor.is_primary() {
        amcp_client.set_read_only(true);
    }

    if let Err(error) = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Audit T1-7: the plugin default rotates at 40 KB with KeepOne, i.e.
        // ~80 KB of history on a 24/7 broadcast host. Keep 10 x 50 MiB.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(50 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(10))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .manage(diagnostics)
        .manage(settings_state)
        .manage(DbState(media_db))
        .manage(MediaProbeState::default())
        .manage(CasparOscListenerState::default())
        .manage(CasparPlaybackState::default())
        .manage(supervisor)
        .manage(amcp_client)
        .invoke_handler(tauri::generate_handler![
            scan_media,
            scan_directory,
            warm_media_cache,
            start_media_probe,
            get_media_probe_status,
            save_media_trim_profile,
            apply_runtime_settings,
            get_diagnostic_logs,
            clear_diagnostic_logs,
            export_diagnostic_logs,
            push_diagnostic_log,
            redact_path_for_diagnostics,
            extract_web_stream,
            get_media_preview_url,
            get_media_preview_info,
            compute_frame_trim,
            parse_timecode,
            get_media_url,
            save_playlist,
            load_playlist,
            caspar_send_command,
            configure_caspar_osc_listener,
            prepare_caspar_media_path,
            caspar_cg_add,
            caspar_cg_update,
            caspar_cg_play,
            caspar_cg_stop,
            caspar_play_image,
            caspar_clear_layer,
            caspar_register_playback,
            caspar_clear_playback,
            caspar_clear_playback_if_uuid,
            caspar_set_playback_paused,
            find_default_caspar_config,
            load_caspar_config,
            save_caspar_config_raw,
            save_caspar_config_structured,
            apply_caspar_decklink_config,
            deploy_caspar_templates,
            open_cg_studio_in_browser,
            open_advisory_in_editor,
            open_template_directory,
            read_svg_file,
            caspar_test_connection,
            list_filesystem_roots,
            browse_filesystem,
            find_default_logos_dir,
            get_image_dimensions,
            resolve_ingestor_asset,
            resolve_ingestor_assets_batch,
            move_ingestor_asset,
            rename_ingestor_asset,
            update_ingestor_trim,
            update_ingestor_rating,
            update_ingestor_tp,
            create_ingestor_subclip,
            purge_ingestor_asset,
            list_ingestor_assets,
            check_ingestor_health,
            list_ingestor_folder_colors,
            set_ingestor_folder_color,
            trash_ingestor_asset,
            trash_ingestor_folder,
            restore_ingestor_asset,
            restore_ingestor_folder,
            list_ingestor_recycle_bin,
            purge_ingestor_recycle_bin,
            purge_ingestor_folder,
            auto_purge_ingestor_recycle_bin,
            verify_playback_ready,
            caspar_process_get_status,
            caspar_process_adopt,
            caspar_process_start,
            caspar_process_stop,
            caspar_process_restart,
            caspar_process_validate_path,
            caspar_process_check_port,
            save_studio_default_preset,
            get_studio_default_preset
        ])
        .setup(|app| {
            init_background_logger();
            let app_handle = app.handle().clone();
            spawn_ingestor_heartbeat(app_handle.clone());
            studio_server::start_studio_server(app_handle);

            let tray_menu = MenuBuilder::new(app)
                .text("tray_show", "Show Window")
                .text("tray_hide", "Hide Window")
                .separator()
                .text("tray_exit", "Exit")
                .build()?;

            let app_handle = app.handle().clone();
            TrayIconBuilder::with_id("playout-main")
                .tooltip("PlayOut")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };

                    match event.id().as_ref() {
                        "tray_show" => {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                        "tray_hide" => {
                            let _ = window.minimize();
                        }
                        "tray_exit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
    {
        startup_error(&format!("error while running tauri application: {}", error));
    }
}
