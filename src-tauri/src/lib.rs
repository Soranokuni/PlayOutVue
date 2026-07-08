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

use caspar::{caspar_send_command, configure_caspar_osc_listener, prepare_caspar_media_path, CasparOscListenerState, caspar_cg_add, caspar_cg_update, caspar_cg_play, caspar_cg_stop, caspar_play_image, caspar_clear_layer, caspar_register_playback, caspar_clear_playback, caspar_set_playback_paused, CasparPlaybackState};
use amcp::AmcpClient;
use caspar_config::{apply_caspar_decklink_config, caspar_test_connection, find_default_caspar_config, load_caspar_config, save_caspar_config_raw, save_caspar_config_structured};
use diagnostics::{clear_diagnostic_logs, export_diagnostic_logs, get_diagnostic_logs, push_diagnostic_log, DiagnosticState, init_background_logger};
use tauri::Manager;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use runtime_settings::{apply_runtime_settings, RuntimeSettingsState};
use scanner::{get_media_probe_status, save_media_trim_profile, scan_media, scan_directory, start_media_probe, warm_media_cache, DbState, MediaProbeState};
use stream::extract_web_stream;
use trimmer::{get_media_preview_info, get_media_preview_url, compute_frame_trim};
use playlist::{save_playlist, load_playlist};
use filesystem::{browse_filesystem, find_default_logos_dir, get_image_dimensions, list_filesystem_roots};
use ingestor_api::{resolve_ingestor_asset, resolve_ingestor_assets_batch, move_ingestor_asset, rename_ingestor_asset, update_ingestor_rating, update_ingestor_trim, list_ingestor_assets, check_ingestor_health, spawn_ingestor_heartbeat, create_ingestor_subclip, update_ingestor_tp, purge_ingestor_asset, list_ingestor_folder_colors, set_ingestor_folder_color};
use transcoder_sidecar::verify_playback_ready;
use db::{MediaDb, default_db_path};

/// Return an HTTP URL that streams a local file to <video src="…">
/// No memory pressure — the media_server streams in 64 KB chunks.
#[tauri::command]
fn get_media_url(path: String) -> String {
    media_server::url_for(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start the local media streaming server (async, random port, no memory overhead)
    let _media_server_runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => {
            if let Err(error) = rt.block_on(media_server::start()) {
                eprintln!("[PlayOut] Media server disabled: {}", error);
                None
            } else {
                Some(rt)
            }
        }
        Err(error) => {
            eprintln!("[PlayOut] Failed to start bootstrap runtime for media server: {}", error);
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
            eprintln!("[PlayOut] Media DB open failed: {}. Using in-memory fallback.", error);
            match MediaDb::open(std::path::Path::new(":memory:")) {
                Ok(memory_db) => memory_db,
                Err(memory_error) => {
                    eprintln!("[PlayOut] In-memory media DB fallback failed: {}. Media cache disabled.", memory_error);
                    MediaDb::disabled(format!("Media cache unavailable: {}; fallback failed: {}", error, memory_error))
                }
            }
        }
    };
    let settings_state = RuntimeSettingsState::default();
    let debug_enabled = settings_state.snapshot().debug_enabled;
    let diagnostics = DiagnosticState::default();
    diagnostics.set_enabled(debug_enabled);

    if let Err(error) = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(diagnostics)
        .manage(settings_state)
        .manage(DbState(media_db))
        .manage(MediaProbeState::default())
        .manage(CasparOscListenerState::default())
        .manage(CasparPlaybackState::default())
        .manage(AmcpClient::new())
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
            extract_web_stream,
            get_media_preview_url,
            get_media_preview_info,
            compute_frame_trim,
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
            caspar_set_playback_paused,
            find_default_caspar_config,
            load_caspar_config,
            save_caspar_config_raw,
            save_caspar_config_structured,
            apply_caspar_decklink_config,
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
            verify_playback_ready
        ])
        .setup(|app| {
            init_background_logger();
            let app_handle = app.handle().clone();
            spawn_ingestor_heartbeat(app_handle);

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

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
    {
        eprintln!("[PlayOut] error while running tauri application: {}", error);
    }
}
