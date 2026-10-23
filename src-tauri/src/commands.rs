use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::{self, Account, Cursor, Folder, MessageRow, ThreadRow};
use crate::error::{AppError, Result};
use crate::state::{AppState, CacheLimits, KEY_BODY_CACHE_MB, KEY_CACHE_DAYS, KEY_CLIENT_ID};
use crate::{auth, mail};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    client_id: Option<String>,
    accounts: Vec<Account>,
    cache_limits: CacheLimits,
}

#[tauri::command]
pub fn bootstrap(state: State<'_, AppState>) -> Result<Bootstrap> {
    Ok(Bootstrap {
        client_id: state.client_id()?,
        accounts: state.db.with(|c| db::list_accounts(c))?,
        cache_limits: state.cache_limits()?,
    })
}

/// Saves the Entra client ID. Changing it signs every account out, because refresh
/// tokens only work with the client ID that issued them. Cached mail is kept.
#[tauri::command]
pub async fn set_client_id(state: State<'_, AppState>, client_id: String) -> Result<()> {
    let id = client_id.trim().to_lowercase();
    if !is_guid(&id) {
        return Err(AppError::Other(
            "That doesn't look like an Application (client) ID. It should look like 00000000-0000-0000-0000-000000000000.".into(),
        ));
    }
    if state.client_id()?.as_deref() == Some(id.as_str()) {
        return Ok(());
    }
    cancel_pending_sign_in(&state);
    state.db.with(|c| {
        db::set_setting(c, KEY_CLIENT_ID, &id)?;
        db::clear_all_tokens(c)
    })?;
    state.forget_all_tokens().await;
    Ok(())
}

fn is_guid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
}

fn cancel_pending_sign_in(state: &AppState) {
    if let Some(tx) = state.sign_in_cancel.lock().expect("cancel mutex").take() {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub fn cancel_sign_in(state: State<'_, AppState>) {
    cancel_pending_sign_in(&state);
}

#[tauri::command]
pub async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<Account> {
    let client_id = state.require_client_id()?;
    // Starting a new sign-in abandons any earlier one still waiting on the browser.
    cancel_pending_sign_in(&state);
    let (tx, rx) = tokio::sync::oneshot::channel();
    *state.sign_in_cancel.lock().expect("cancel mutex") = Some(tx);
    let tokens = auth::sign_in(&app, &state.http, &client_id, rx).await?;
    let (email, display_name) = mail::fetch_profile(&state.http, &tokens.access_token).await?;
    let blob = AppState::store_tokens_blob(&tokens)?;
    let account = state
        .db
        .with(|c| db::upsert_account(c, "microsoft", &email, display_name.as_deref(), &blob))?;
    state.remember_tokens(account.id, tokens).await;

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = mail::sync_all(&app2).await;
    });
    Ok(account)
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>, account_id: i64) -> Result<()> {
    state.forget_tokens(account_id).await;
    state.db.with(|c| db::delete_account(c, account_id))
}

#[tauri::command]
pub fn list_folders(state: State<'_, AppState>, account_id: i64) -> Result<Vec<Folder>> {
    state.db.with(|c| db::list_folders(c, account_id))
}

#[tauri::command]
pub fn list_threads(
    state: State<'_, AppState>,
    folder_id: i64,
    cursor: Option<Cursor>,
    limit: Option<i64>,
) -> Result<Vec<ThreadRow>> {
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    state.db.with(|c| db::list_threads(c, folder_id, cursor.as_ref(), limit))
}

#[tauri::command]
pub fn get_thread(state: State<'_, AppState>, account_id: i64, conversation_id: String) -> Result<Vec<MessageRow>> {
    state.db.with(|c| db::get_thread(c, account_id, &conversation_id))
}

#[tauri::command]
pub async fn get_message_body(state: State<'_, AppState>, message_id: i64) -> Result<String> {
    mail::message_body(&state, message_id).await
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<()> {
    mail::sync_all(&app).await
}

#[tauri::command]
pub async fn set_cache_limits(app: AppHandle, state: State<'_, AppState>, limits: CacheLimits) -> Result<()> {
    let days = limits.cache_days.clamp(7, 3650);
    let mb = limits.body_cache_mb.clamp(50, 20_000);
    let previous = state.cache_limits()?;
    state.db.with(|c| {
        db::set_setting(c, KEY_CACHE_DAYS, &days.to_string())?;
        db::set_setting(c, KEY_BODY_CACHE_MB, &mb.to_string())?;
        db::evict_bodies(c, mb * 1024 * 1024)?;
        // A wider window needs a fresh delta (the date filter is baked into the delta link).
        if days > previous.cache_days {
            db::clear_delta_links(c)?;
        }
        Ok(())
    })?;
    tauri::async_runtime::spawn(async move {
        let _ = mail::sync_all(&app).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn validates_guids() {
        assert!(super::is_guid("e7f36417-119b-4407-8631-35b13727823a"));
        assert!(!super::is_guid("e7f36417119b4407863135b13727823a"));
        assert!(!super::is_guid("e7f36417-119b-4407-8631-35b13727823"));
        assert!(!super::is_guid("g7f36417-119b-4407-8631-35b13727823a"));
        assert!(!super::is_guid("--------------------------------e7f3"));
    }
}
