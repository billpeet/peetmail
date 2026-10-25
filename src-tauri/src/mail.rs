//! Mail sync against Microsoft Graph. Incremental via delta links, so steady-state
//! polls are one cheap request per folder.

use chrono::{Duration, Utc};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::db::{self, Account, Folder, MessageUpsert};
use crate::error::{AppError, Result};
use crate::graph::{self, PREFER_IMMUTABLE};
use crate::{outbox, sanitize};
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
    let me = graph::get(http, token, &format!("{}/me?$select=displayName,mail,userPrincipalName", graph::base()), &[]).await?;
    let email = me["mail"]
        .as_str()
        .or_else(|| me["userPrincipalName"].as_str())
        .ok_or_else(|| AppError::Other("profile has no email address".into()))?
        .to_lowercase();
    Ok((email, me["displayName"].as_str().map(String::from)))
}

/// Graph request with the account's token. A 401 means the token was revoked or expired
/// early (password change, admin action, clock skew), so drop it, refresh, and retry once.
pub async fn graph_call(
    state: &AppState,
    account_id: i64,
    method: Method,
    url: &str,
    body: Option<&Value>,
    prefer: &[&str],
) -> Result<Value> {
    let token = state.access_token(account_id).await?;
    match graph::request(&state.http, &token, method.clone(), url, body, prefer).await {
        Err(AppError::Graph { status: 401, .. }) => {
            log::warn!("graph returned 401 for account {account_id}, refreshing token");
            state.invalidate_access_token(account_id).await;
            let token = state.access_token(account_id).await?;
            graph::request(&state.http, &token, method, url, body, prefer).await
        }
        other => other,
    }
}

async fn graph_get(state: &AppState, account_id: i64, url: &str, prefer: &[&str]) -> Result<Value> {
    graph_call(state, account_id, Method::GET, url, None, prefer).await
}

async fn graph_bytes(state: &AppState, account_id: i64, url: &str) -> Result<Vec<u8>> {
    let token = state.access_token(account_id).await?;
    match graph::get_bytes(&state.http, &token, url).await {
        Err(AppError::Graph { status: 401, .. }) => {
            state.invalidate_access_token(account_id).await;
            let token = state.access_token(account_id).await?;
            graph::get_bytes(&state.http, &token, url).await
        }
        other => other,
    }
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
    tauri::async_runtime::spawn(prefetch_bodies(app.clone()));
    Ok(())
}

/// Bodies kept warm: the newest inbox messages plus every unread one.
const PREFETCH_NEWEST: i64 = 60;
const PREFETCH_MAX: i64 = 200;
const PREFETCH_CONCURRENCY: usize = 4;

/// Downloads bodies the user is likely to open next into the SQLite cache, so opening a
/// message never waits on the network. Runs after each sync; already-cached bodies are skipped.
pub async fn prefetch_bodies(app: AppHandle) {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.prefetch_lock.try_lock() else { return };
    let ids = match state.db.with(|c| db::bodies_to_prefetch(c, PREFETCH_NEWEST, PREFETCH_MAX)) {
        Ok(ids) => ids,
        Err(e) => return log::error!("prefetch query: {e}"),
    };
    if ids.is_empty() {
        return;
    }
    log::info!("prefetching {} message bodies", ids.len());
    let mut tasks = tokio::task::JoinSet::new();
    for id in ids {
        while tasks.len() >= PREFETCH_CONCURRENCY {
            tasks.join_next().await;
        }
        let app = app.clone();
        tasks.spawn(async move {
            let state = app.state::<AppState>();
            if let Err(e) = message_body(&state, id).await {
                log::info!("prefetch body {id}: {e}");
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

/// Folders kept in sync. Sent is synced so threads show your replies; Archive and
/// Deleted Items only exist locally as move targets.
const SYNCED_FOLDERS: &[(&str, &str)] = &[("inbox", "Inbox"), ("sentitems", "Sent Items")];

async fn sync_account(app: &AppHandle, state: &AppState, account: &Account) -> Result<()> {
    for (role, name) in SYNCED_FOLDERS {
        let folder = ensure_folder(state, account.id, role, name).await?;
        sync_folder(app, state, account.id, &folder).await?;
    }
    Ok(())
}

/// The folder row for a well-known Graph folder, fetching its id on first use.
async fn ensure_folder(state: &AppState, account_id: i64, role: &str, default_name: &str) -> Result<Folder> {
    if let Some(f) = state.db.with(|c| db::folder_by_role(c, account_id, role))? {
        return Ok(f);
    }
    let f = graph_get(
        state,
        account_id,
        &format!("{}/me/mailFolders/{role}?$select=id,displayName", graph::base()),
        &[PREFER_IMMUTABLE],
    )
    .await?;
    let remote_id = f["id"].as_str().ok_or_else(|| AppError::Other(format!("{role} folder has no id")))?;
    let name = f["displayName"].as_str().unwrap_or(default_name);
    state.db.with(|c| db::insert_folder(c, account_id, remote_id, role, name))
}

fn initial_delta_url(folder: &Folder, since: Option<&str>) -> String {
    let base = format!("{}/me/mailFolders/{}/messages/delta", graph::base(), folder.remote_id);
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
        let page = match graph_get(state, account_id, &url, &[PREFER_IMMUTABLE, PAGE_SIZE]).await {
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
                // Messages with unsent local changes keep their local state until the outbox
                // catches up; the next delta after that reflects the server's truth.
                let busy = outbox::busy_remote_ids(c, account_id)?;
                let tx = c.transaction()?;
                for item in &items {
                    let Some(remote_id) = item["id"].as_str() else { continue };
                    if busy.contains(remote_id) {
                        continue;
                    }
                    if item.get("@removed").is_some() {
                        db::delete_message_in_folder(&tx, account_id, folder.id, remote_id)?;
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
        // Meeting invites and responses arrive as #microsoft.graph.eventMessage.
        message_type: v
            .get("@odata.type")
            .and_then(Value::as_str)
            .map(|t| if t.contains("eventMessage") { "eventMessage" } else { "message" }.to_string()),
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
    let v = graph_get(
        state,
        account_id,
        &format!("{}/me/messages/{remote_id}?$select=body", graph::base()),
        &[PREFER_IMMUTABLE, r#"outlook.body-content-type="html""#],
    )
    .await?;
    let content = v.pointer("/body/content").and_then(Value::as_str).unwrap_or_default();
    let mut html = match v.pointer("/body/contentType").and_then(Value::as_str) {
        Some("text") => sanitize::text_to_html(content),
        _ => sanitize::clean_html(content),
    };
    if html.contains("src=\"cid:") {
        match inline_cid_images(state, account_id, &remote_id, &html).await {
            Ok(h) => html = h,
            Err(e) => log::warn!("inline images for message {message_id}: {e}"),
        }
    }
    let text = sanitize::html_to_text(&html);
    let max_bytes = state.cache_limits()?.body_cache_mb * 1024 * 1024;
    state.db.with(|c| {
        db::put_body(c, message_id, &html, &text)?;
        db::evict_bodies(c, max_bytes)?;
        Ok(())
    })?;
    Ok(html)
}

const MAX_INLINE_BYTES: usize = 5 * 1024 * 1024;

/// Replaces `cid:` image references with data URIs from the message's inline attachments.
async fn inline_cid_images(state: &AppState, account_id: i64, remote_id: &str, html: &str) -> Result<String> {
    let list = graph_get(
        state,
        account_id,
        &format!("{}/me/messages/{remote_id}/attachments?$filter=isInline eq true", graph::base()),
        &[PREFER_IMMUTABLE],
    )
    .await?;
    let mut by_cid = std::collections::HashMap::new();
    for a in list["value"].as_array().into_iter().flatten() {
        let (Some(cid), Some(ct), Some(bytes)) = (a["contentId"].as_str(), a["contentType"].as_str(), a["contentBytes"].as_str())
        else {
            continue;
        };
        if ct.starts_with("image/") && bytes.len() <= MAX_INLINE_BYTES * 4 / 3 {
            by_cid.insert(cid.trim_matches(['<', '>']).to_string(), format!("data:{ct};base64,{bytes}"));
        }
    }
    Ok(sanitize::rewrite_img_src(html, |src| src.strip_prefix("cid:").and_then(|cid| by_cid.get(cid).cloned())))
}

/// The cached body with remote images fetched by Rust and inlined as data URIs, so the
/// WebView never contacts the sender's servers and the CSP stays strict. Not cached.
pub async fn message_body_with_images(state: &AppState, message_id: i64) -> Result<String> {
    use base64::Engine;
    let html = message_body(state, message_id).await?;
    let mut fetched = std::collections::HashMap::new();
    for url in sanitize::remote_images(&html).iter().take(60) {
        match fetch_image(&state.http, url).await {
            Ok((ct, bytes)) => {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                fetched.insert(url.clone(), format!("data:{ct};base64,{data}"));
            }
            Err(e) => log::info!("image {url}: {e}"),
        }
    }
    Ok(sanitize::rewrite_img_src(&html, |src| fetched.get(&src.replace("&amp;", "&")).cloned()))
}

async fn fetch_image(http: &reqwest::Client, url: &str) -> Result<(String, Vec<u8>)> {
    let res = http.get(url).timeout(std::time::Duration::from_secs(10)).send().await?.error_for_status()?;
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    // SVG can carry script; only raster formats go into the page.
    if !ct.starts_with("image/") || ct.contains("svg") {
        return Err(AppError::Other(format!("not a raster image ({ct})")));
    }
    let bytes = res.bytes().await?;
    if bytes.len() > MAX_INLINE_BYTES {
        return Err(AppError::Other("image too large".into()));
    }
    Ok((ct, bytes.to_vec()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size: i64,
}

fn remote_of(state: &AppState, message_id: i64) -> Result<(i64, String)> {
    state
        .db
        .with(|c| db::message_remote(c, message_id))?
        .ok_or_else(|| AppError::Other("message not found".into()))
}

/// Non-inline attachments of a message.
pub async fn list_attachments(state: &AppState, message_id: i64) -> Result<Vec<Attachment>> {
    let (account_id, remote_id) = remote_of(state, message_id)?;
    let v = graph_get(
        state,
        account_id,
        &format!("{}/me/messages/{remote_id}/attachments?$select=id,name,contentType,size,isInline", graph::base()),
        &[PREFER_IMMUTABLE],
    )
    .await?;
    Ok(v["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| !a["isInline"].as_bool().unwrap_or(false))
        .map(|a| Attachment {
            id: a["id"].as_str().unwrap_or_default().into(),
            name: a["name"].as_str().unwrap_or("attachment").into(),
            content_type: a["contentType"].as_str().unwrap_or_default().into(),
            size: a["size"].as_i64().unwrap_or(0),
        })
        .collect())
}

/// Downloads an attachment into `dir` under a free, sanitized file name. Returns the path.
pub async fn download_attachment(
    state: &AppState,
    message_id: i64,
    attachment_id: &str,
    name: &str,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf> {
    let (account_id, remote_id) = remote_of(state, message_id)?;
    let bytes = graph_bytes(
        state,
        account_id,
        &format!("{}/me/messages/{remote_id}/attachments/{attachment_id}/$value", graph::base()),
    )
    .await?;
    std::fs::create_dir_all(dir)?;
    let path = unique_path(dir, &safe_file_name(name));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "attachment".into() } else { trimmed }
}

fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).expect("a free file name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name(r#"..\..\evil:name?.exe"#), "_.._evil_name_.exe");
        assert_eq!(safe_file_name("   "), "attachment");
    }

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
