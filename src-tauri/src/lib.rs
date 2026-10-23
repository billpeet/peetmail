mod auth;
mod commands;
mod db;
mod error;
mod graph;
mod mail;
mod sanitize;
mod secure;
mod state;

use std::time::Duration;

use tauri::Manager;

/// Delta polls are cheap; Graph change notifications need a public webhook,
/// which a desktop app doesn't have.
const SYNC_INTERVAL: Duration = Duration::from_secs(60);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("peetmail.db"))?;
            app.manage(state::AppState::new(db));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Err(e) = mail::sync_all(&handle).await {
                        log::error!("background sync: {e}");
                    }
                    tokio::time::sleep(SYNC_INTERVAL).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::set_client_id,
            commands::sign_in,
            commands::cancel_sign_in,
            commands::sign_out,
            commands::list_folders,
            commands::list_threads,
            commands::get_thread,
            commands::get_message_body,
            commands::sync_now,
            commands::set_cache_limits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
