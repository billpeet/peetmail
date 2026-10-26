mod actions;
mod auth;
mod calendar;
mod commands;
mod db;
mod error;
mod graph;
mod mail;
mod outbox;
mod query;
mod sanitize;
mod secure;
mod state;
mod testenv;

use std::time::Duration;

use tauri::{Emitter, Manager};

/// Delta polls are cheap; Graph change notifications need a public webhook,
/// which a desktop app doesn't have.
const DEFAULT_SYNC_INTERVAL_SECS: u64 = 60;

/// The main window is built in code (not tauri.conf.json) so the test harness can
/// run it headless: off-screen, out of the taskbar, and never stealing focus.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let headless = testenv::flag("PEETMAIL_HEADLESS");
    let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title("PeetMail")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 560.0)
        // The title bar is drawn by the app (TitleBar.svelte); keep the native shadow.
        .decorations(false)
        .shadow(true)
        .background_color(tauri::window::Color(38, 38, 42, 255));
    builder = if headless {
        // Never shown: WebView2 keeps rendering (screenshots, input over CDP) for a
        // hidden window, and nothing flashes up or steals focus.
        builder.visible(false).focused(false).skip_taskbar(true)
    } else {
        builder.center()
    };
    builder.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir_override = testenv::get("PEETMAIL_DATA_DIR").map(std::path::PathBuf::from);
    let sync_interval = Duration::from_secs(
        testenv::get("PEETMAIL_SYNC_INTERVAL_SECS")
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_SYNC_INTERVAL_SECS),
    );

    let mut log = tauri_plugin_log::Builder::new().level(log::LevelFilter::Info);
    if let Some(dir) = &data_dir_override {
        // Keep test logs next to the test database instead of mixing them with the real app's.
        log = log.clear_targets().targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: dir.join("logs"),
                file_name: Some("PeetMail".into()),
            }),
        ]);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(log.build())
        .setup(move |app| {
            let dir = match data_dir_override {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("peetmail.db"))?;
            db.with(|c| outbox::reset_inflight(c))?;
            app.manage(state::AppState::new(db));
            create_main_window(app)?;

            // Snoozes wake on time: a cheap indexed check each second.
            let snoozer = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let state = snoozer.state::<state::AppState>();
                    match state.db.with(|c| actions::wake(c, None)) {
                        Ok(accounts) if !accounts.is_empty() => {
                            outbox::emit_status(&snoozer, &state);
                            outbox::kick(&snoozer);
                            for a in accounts {
                                let _ = snoozer.emit(mail::EVENT_MAIL_CHANGED, serde_json::json!({ "accountId": a, "folderId": null }));
                            }
                        }
                        Ok(_) => {}
                        Err(e) => log::error!("waking snoozes: {e}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    // Retry anything queued while offline before pulling changes.
                    outbox::kick(&handle);
                    if let Err(e) = mail::sync_all(&handle).await {
                        log::error!("background sync: {e}");
                    }
                    tokio::time::sleep(sync_interval).await;
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
            commands::set_preferences,
            commands::record_open,
            commands::recent_opens,
            commands::list_events,
            commands::invite_event,
            commands::respond_to_event,
            commands::create_event,
            commands::snooze_thread,
            commands::unsnooze_thread,
            commands::list_snoozed,
            commands::list_snippets,
            commands::set_snippets,
            commands::cancel_send,
            commands::scheduled_sends,
            commands::thread_action,
            commands::undo,
            commands::outbox_status,
            commands::send_message,
            commands::suggest_contacts,
            commands::list_splits,
            commands::set_splits,
            commands::get_message_body_with_images,
            commands::list_attachments,
            commands::download_attachment,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
