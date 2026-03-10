mod scanner;
mod stream;
mod trimmer;
mod playlist;
mod db;
mod media_server;
mod caspar;
mod caspar_config;
mod filesystem;

use caspar::{caspar_send_command, configure_caspar_osc_listener, prepare_caspar_media_path, CasparOscListenerState};
use caspar_config::{find_default_caspar_config, load_caspar_config, save_caspar_config_raw, save_caspar_config_structured};
use scanner::{scan_media, scan_directory, warm_media_cache, DbState};
use stream::extract_web_stream;
use trimmer::{get_media_preview_url, trim_file, trim_file_smart};
use playlist::{save_playlist, load_playlist};
use filesystem::{browse_filesystem, find_default_logos_dir, get_image_dimensions, list_filesystem_roots};
use db::{MediaDb, default_db_path};
use std::sync::Mutex;

/// Return an HTTP URL that streams a local file to <video src="…">
/// No memory pressure — the media_server streams in 64 KB chunks.
#[tauri::command]
fn get_media_url(path: String) -> String {
    media_server::url_for(&path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start the local media streaming server (async, random port, no memory overhead)
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(media_server::start());

    // Open (or create) the SQLite media metadata cache
    let db_path = default_db_path();
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let media_db = MediaDb::open(&db_path).unwrap_or_else(|e| {
        eprintln!("[PlayOut] Media DB open failed: {}. Using in-memory fallback.", e);
        MediaDb::open(std::path::Path::new(":memory:")).expect("in-memory DB failed")
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DbState(Mutex::new(media_db)))
        .manage(CasparOscListenerState::default())
        .invoke_handler(tauri::generate_handler![
            scan_media,
            scan_directory,
            warm_media_cache,
            extract_web_stream,
            trim_file,
            trim_file_smart,
            get_media_url,
            get_media_preview_url,
            save_playlist,
            load_playlist,
            caspar_send_command,
            configure_caspar_osc_listener,
            prepare_caspar_media_path,
            find_default_caspar_config,
            load_caspar_config,
            save_caspar_config_raw,
            save_caspar_config_structured,
            list_filesystem_roots,
            browse_filesystem,
            find_default_logos_dir,
            get_image_dimensions
        ])
        .setup(|app| {
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
        .expect("error while running tauri application");
}
