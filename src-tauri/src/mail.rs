//! Mail sync against Microsoft Graph. Incremental via delta links, so steady-state
//! polls are one cheap request per folder.

use chrono::{Duration, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::db::{self, Account, Folder, MessageUpsert};
use crate::error::{AppError, Result};
use crate::graph::{self, BASE, PREFER_IMMUTABLE};
use crate::sanitize;
use crate::state::AppState;

const MESSAGE_FIELDS: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,\
bodyPreview,isRead,flag,hasAttachments,importance,inferenceClassification";
const PAGE_SIZE: &str = "odata.maxpagesize=100";

pub const EVENT_MAIL_CHANGED: &str = "mail-changed";
pub const EVENT_SYNC_STATUS: &str = "sync-status";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: &'static str, // "syncing" | "idle" | "error"
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MailChanged {
    account_id: i64,
    folder_id: i64,
}

pub async fn fetch_profile(http: &reqwest::Client, token: &str) -> Result<(String, Option<String>)> {
    let me = graph::get(http, token, &format!("{BASE}/me?$select=displayName,mail,userPrincipalName"), &[]).await?;
    let email = me["mail"]
        .as_str()
        .or_else(|| me["userPrincipalName"].as_str())
        .ok_or_else(|| AppError::Other("profile has no email address".into()))?
        .to_lowercase();
    Ok((email, me["displayName"].as_str().map(String::from)))
}

/// Syncs every account. Errors are reported per account and don't stop the others.
pub async fn sync_all(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let _guard = state.sync_lock.lock().await;
    let accounts = state.db.with(|c| db::list_accounts(c))?;
    let _ = app.emit(EVENT_SYNC_STATUS, SyncStatus { state: "syncing", message: None });

    let mut last_error = None;
    for account in accounts.iter().filter(|a| a.signed_in) {
        if let Err(e) = sync_account(app, &state, account).await {
            log::error!("sync failed for {}: {e}", account.email);
            last_error = Some(format!("{}: {e}", account.email));
        }
    }

    let status = match last_error {
        Some(msg) => SyncStatus { state: "error", message: Some(msg) },
        None => SyncStatus { state: "idle", message: None },
    };
    let _ = app.emit(EVENT_SYNC_STATUS, status);
    Ok(())
}

async fn sync_account(app: &AppHandle, state: &AppState, account: &Account) -> Result<()> {
    let inbox = ensure_inbox(state, account.id).await?;
    sync_folder(app, state, account.id, &inbox).await
}

async fn ensure_inbox(state: &AppState, account_id: i64) -> Result<Folder> {
    if let Some(f) = state.db.with(|c| db::folder_by_role(c, account_id, "inbox"))? {
        return Ok(f);
    }
    let token = state.access_token(account_id).await?;
    let f = graph::get(
        &state.http,
        &token,
        &format!("{BASE}/me/mailFolders/inbox?$select=id,displayName"),
        &[PREFER_IMMUTABLE],
    )
    .await?;
    let remote_id = f["id"].as_str().ok_or_else(|| AppError::Other("inbox has no id".into()))?;
    let name = f["displayName"].as_str().unwrap_or("Inbox");
    state.db.with(|c| db::insert_folder(c, account_id, remote_id, "inbox", name))
}

fn initial_delta_url(folder: &Folder, since: Option<&str>) -> String {
    let base = format!("{BASE}/me/mailFolders/{}/messages/delta", folder.remote_id);
    let mut params = vec![("$select", MESSAGE_FIELDS.to_string())];
    if let Some(since) = since {
        params.push(("$filter", format!("receivedDateTime ge {since}")));
    }
    Url::parse_with_params(&base, &params).expect("valid url").to_string()
}

async fn sync_folder(app: &AppHandle, state: &AppState, account_id: i64, folder: &Folder) -> Result<()> {
    let limits = state.cache_limits()?;
    let cutoff = (Utc::now() - Duration::days(limits.cache_days)).format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let full_sync = folder.delta_link.is_none();
    let mut url = folder.delta_link.clone().unwrap_or_else(|| initial_delta_url(folder, Some(&cutoff)));
    // Set if Graph rejects the server-side date filter, so we filter locally instead.
    let mut filter_locally = false;
    let mut restarted = false;
    let mut first_page = true;

    loop {
        let token = state.access_token(account_id).await?;
        let page = match graph::get(&state.http, &token, &url, &[PREFER_IMMUTABLE, PAGE_SIZE]).await {
            Ok(p) => p,
            Err(AppError::Graph { status: 400, message }) if first_page && full_sync && !filter_locally => {
                log::warn!("delta $filter rejected ({message}), filtering locally");
                filter_locally = true;
                url = initial_delta_url(folder, None);
                continue;
            }
            Err(AppError::Graph { status: 410, .. }) if !restarted => {
                log::warn!("delta link expired for folder {}, resyncing", folder.id);
                restarted = true;
                state.db.with(|c| db::set_delta_link(c, folder.id, None))?;
                url = initial_delta_url(folder, Some(&cutoff));
                continue;
            }
            Err(e) => return Err(e),
        };
        first_page = false;

        let items = page["value"].as_array().cloned().unwrap_or_default();
        if !items.is_empty() {
            state.db.with(|c| {
                let tx = c.transaction()?;
                for item in &items {
                    let Some(remote_id) = item["id"].as_str() else { continue };
                    if item.get("@removed").is_some() {
                        db::delete_message(&tx, account_id, remote_id)?;
                        continue;
                    }
                    let m = parse_message(item);
                    if filter_locally && m.received_at.as_deref().is_some_and(|at| at < cutoff.as_str()) {
                        continue;
                    }
                    db::upsert_message(&tx, account_id, folder.id, &m)?;
                }
                tx.commit()?;
                Ok(())
            })?;
            let _ = app.emit(EVENT_MAIL_CHANGED, MailChanged { account_id, folder_id: folder.id });
        }

        if let Some(next) = page["@odata.nextLink"].as_str() {
            url = next.to_string();
            continue;
        }
        let delta = page["@odata.deltaLink"].as_str();
        state.db.with(|c| db::set_delta_link(c, folder.id, delta))?;
        break;
    }

    let pruned = state.db.with(|c| db::prune_older_than(c, folder.id, &cutoff))?;
    if pruned > 0 {
        let _ = app.emit(EVENT_MAIL_CHANGED, MailChanged { account_id, folder_id: folder.id });
    }
    Ok(())
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn recipients(v: &Value, key: &str) -> Option<String> {
    let list = v.get(key)?.as_array()?;
    let simplified: Vec<Value> = list
        .iter()
        .map(|r| json!({ "name": r["emailAddress"]["name"], "address": r["emailAddress"]["address"] }))
        .collect();
    Some(Value::Array(simplified).to_string())
}

/// Graph fields missing from the payload map to `None` so partial delta updates
/// don't overwrite cached values.
pub fn parse_message(v: &Value) -> MessageUpsert {
    MessageUpsert {
        remote_id: str_field(v, "id").unwrap_or_default(),
        conversation_id: str_field(v, "conversationId"),
        subject: v.get("subject").map(|s| s.as_str().unwrap_or_default().to_string()),
        from_name: v.pointer("/from/emailAddress/name").and_then(Value::as_str).map(String::from),
        from_address: v.pointer("/from/emailAddress/address").and_then(Value::as_str).map(String::from),
        to_json: recipients(v, "toRecipients"),
        cc_json: recipients(v, "ccRecipients"),
        received_at: str_field(v, "receivedDateTime"),
        preview: str_field(v, "bodyPreview"),
        is_read: v.get("isRead").and_then(Value::as_bool),
        is_flagged: v.pointer("/flag/flagStatus").and_then(Value::as_str).map(|s| s == "flagged"),
        has_attachments: v.get("hasAttachments").and_then(Value::as_bool),
        importance: str_field(v, "importance"),
        inference: str_field(v, "inferenceClassification"),
    }
}

/// Returns sanitized HTML for a message, from cache or Graph.
pub async fn message_body(state: &AppState, message_id: i64) -> Result<String> {
    if let Some(html) = state.db.with(|c| db::get_body(c, message_id))? {
        return Ok(html);
    }
    let (account_id, remote_id) = state
        .db
        .with(|c| db::message_remote(c, message_id))?
        .ok_or_else(|| AppError::Other("message not found".into()))?;
    let token = state.access_token(account_id).await?;
    let v = graph::get(
        &state.http,
        &token,
        &format!("{BASE}/me/messages/{remote_id}?$select=body"),
        &[PREFER_IMMUTABLE, r#"outlook.body-content-type="html""#],
    )
    .await?;
    let content = v.pointer("/body/content").and_then(Value::as_str).unwrap_or_default();
    let html = match v.pointer("/body/contentType").and_then(Value::as_str) {
        Some("text") => sanitize::text_to_html(content),
        _ => sanitize::clean_html(content),
    };
    let max_bytes = state.cache_limits()?.body_cache_mb * 1024 * 1024;
    state.db.with(|c| {
        db::put_body(c, message_id, &html)?;
        db::evict_bodies(c, max_bytes)?;
        Ok(())
    })?;
    Ok(html)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_and_partial_messages() {
        let full = json!({
            "id": "AAA", "conversationId": "C1", "subject": "Hello",
            "from": { "emailAddress": { "name": "Sam", "address": "sam@example.com" } },
            "toRecipients": [{ "emailAddress": { "name": "Boris", "address": "boris@example.com" } }],
            "receivedDateTime": "2026-10-20T08:00:00Z", "bodyPreview": "Hi there",
            "isRead": false, "flag": { "flagStatus": "flagged" }, "hasAttachments": true
        });
        let m = parse_message(&full);
        assert_eq!(m.from_address.as_deref(), Some("sam@example.com"));
        assert_eq!(m.is_flagged, Some(true));
        assert!(m.to_json.unwrap().contains("boris@example.com"));
        assert_eq!(m.cc_json, None);

        let partial = parse_message(&json!({ "id": "AAA", "isRead": true }));
        assert_eq!(partial.is_read, Some(true));
        assert_eq!(partial.subject, None);
        assert_eq!(partial.received_at, None);
    }

    #[test]
    fn initial_url_encodes_filter() {
        let f = Folder {
            id: 1, account_id: 1, remote_id: "INBOX=".into(), role: Some("inbox".into()),
            name: "Inbox".into(), delta_link: None, last_synced_at: None,
        };
        let u = initial_delta_url(&f, Some("2026-01-01T00:00:00Z"));
        assert!(u.starts_with("https://graph.microsoft.com/v1.0/me/mailFolders/INBOX=/messages/delta?"));
        assert!(u.contains("%24filter=receivedDateTime+ge+2026-01-01T00%3A00%3A00Z"));
    }
}
