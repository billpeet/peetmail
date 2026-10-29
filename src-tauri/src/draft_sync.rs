//! Keeps drafts in step with the account's own drafts: Outlook's Drafts folder (Graph) and
//! Gmail's drafts. The last save wins:
//!
//! - A local edit marks the draft changed and queues a push (`Op::PushDraft`, outbox.rs),
//!   which creates or updates the server's copy and records its version.
//! - Each sync lists the server's drafts. One whose version moved on, and that wasn't
//!   changed here since the last push, replaces the local copy; one new on the server is
//!   added; one gone from the server goes here too. A draft changed here keeps its edits
//!   (its push overwrites the server's).
//! - Sending removes the server's copy. A draft started elsewhere is sent through its server
//!   copy (Graph send, Gmail drafts.send), which keeps its threading.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Method;
use serde_json::{json, Value};

use crate::db;
use crate::draft_files::{self, DraftFile};
use crate::drafts::{self, DraftDoc, DraftRow, RemoteMeta};
use crate::error::{AppError, Result};
use crate::graph::{self, PREFER_IMMUTABLE};
use crate::mail::graph_call;
use crate::outbox::{Draft, DraftKind};
use crate::state::AppState;
use crate::{gmail, gmail_send, sanitize};

pub const EVENT_DRAFTS_CHANGED: &str = "drafts-changed";

fn is_google(state: &AppState, account_id: i64) -> Result<bool> {
    Ok(state.db.with(|c| db::account_provider(c, account_id))? == "google")
}

/// Addresses as typed ("a@x, b@y;") as a list.
fn addresses(s: &str) -> Vec<String> {
    s.split([',', ';']).map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect()
}

/// The HTML a draft goes up with (the same as it would be sent with, minus any quote).
fn html_of(doc: &DraftDoc) -> String {
    Draft { body: doc.body.clone(), html: doc.html.clone(), ..Default::default() }.html_body()
}

/// The server id of the draft a send came from.
pub fn remote_of(state: &AppState, d: &Draft) -> Result<Option<String>> {
    let Some(id) = d.draft_id else { return Ok(None) };
    Ok(state.db.with(|c| drafts::get(c, id))?.and_then(|r| r.remote_id))
}

/// For a send: the server copy to send it through, if it's a draft started elsewhere.
pub fn server_copy_to_send(state: &AppState, d: &Draft) -> Result<Option<String>> {
    let Some(id) = d.draft_id else { return Ok(None) };
    Ok(state.db.with(|c| drafts::get(c, id))?.filter(|r| r.doc.imported).and_then(|r| r.remote_id))
}

// ---------- push ----------

/// Puts a draft's latest content on the server (an `Op::PushDraft`).
pub async fn push(state: &AppState, id: i64) -> Result<()> {
    let _lock = state.drafts_lock.lock().await;
    let Some(row) = state.db.with(|c| drafts::get(c, id))? else { return Ok(()) };
    // Being sent (the send has the content), or nothing new since the last push.
    if row.hidden || !row.dirty {
        return Ok(());
    }
    let (rid, version) = push_doc(state, &row, &row.doc).await?;
    let still_here = state.db.with(|c| {
        Ok(match drafts::get(c, id)? {
            Some(_) => {
                drafts::mark_pushed(c, id, row.seq, &rid, &version)?;
                true
            }
            None => false,
        })
    })?;
    // Discarded while it went up: don't leave the copy behind.
    if !still_here {
        delete_remote(state, row.account_id, &rid).await?;
    }
    Ok(())
}

/// Creates or updates the server's copy of `doc` (the draft in `row`). Returns its server
/// id and version.
async fn push_doc(state: &AppState, row: &DraftRow, doc: &DraftDoc) -> Result<(String, String)> {
    if is_google(state, row.account_id)? { gmail_push(state, row, doc).await } else { graph_push(state, row, doc).await }
}

fn recipients(list: &str) -> Value {
    Value::Array(addresses(list).iter().map(|a| json!({ "emailAddress": { "address": a } })).collect())
}

/// The Graph id of the message a reply or forward answers.
fn reference_remote(state: &AppState, doc: &DraftDoc) -> Result<Option<String>> {
    let Some(id) = doc.reference_message_id.filter(|_| doc.kind != DraftKind::New && !doc.imported) else { return Ok(None) };
    Ok(state.db.with(|c| db::message_remote(c, id))?.map(|(_, rid)| rid))
}

async fn graph_push(state: &AppState, row: &DraftRow, doc: &DraftDoc) -> Result<(String, String)> {
    let base = graph::base();
    let a = row.account_id;
    let fields = json!({
        "subject": doc.subject,
        "body": { "contentType": "HTML", "content": html_of(doc) },
        "toRecipients": recipients(&doc.to),
        "ccRecipients": recipients(&doc.cc),
        "bccRecipients": recipients(&doc.bcc),
    });
    let mut rid = row.remote_id.clone();
    if let Some(r) = &rid {
        match graph_call(state, a, Method::PATCH, &format!("{base}/me/messages/{r}"), Some(&fields), &[PREFER_IMMUTABLE]).await {
            Ok(_) => {}
            // Deleted on the server meanwhile: this save is the later one, so it comes back.
            Err(AppError::Graph { status: 404, .. }) => rid = None,
            Err(e) => return Err(e),
        }
    }
    let rid = match rid {
        Some(r) => r,
        None => {
            let created = match reference_remote(state, doc)? {
                // A reply or forward starts as Graph's own reply draft, so Outlook threads it.
                Some(orig) => {
                    let action = match doc.kind {
                        DraftKind::Reply => "createReply",
                        DraftKind::ReplyAll => "createReplyAll",
                        _ => "createForward",
                    };
                    let c = graph_call(state, a, Method::POST, &format!("{base}/me/messages/{orig}/{action}"), Some(&json!({})), &[PREFER_IMMUTABLE]).await?;
                    let id = c["id"].as_str().unwrap_or_default();
                    graph_call(state, a, Method::PATCH, &format!("{base}/me/messages/{id}"), Some(&fields), &[PREFER_IMMUTABLE]).await?;
                    c
                }
                None => graph_call(state, a, Method::POST, &format!("{base}/me/messages"), Some(&fields), &[PREFER_IMMUTABLE]).await?,
            };
            created["id"].as_str().ok_or_else(|| AppError::Other("Graph returned a draft without an id".into()))?.to_string()
        }
    };
    graph_sync_files(state, a, &rid, doc).await?;
    let v = graph_call(state, a, Method::GET, &format!("{base}/me/messages/{rid}?$select=lastModifiedDateTime"), None, &[PREFER_IMMUTABLE]).await?;
    Ok((rid, v["lastModifiedDateTime"].as_str().unwrap_or_default().to_string()))
}

/// Makes the server draft's attachments match the local files (by name). A forward keeps
/// the original's attachments Graph copied in, except the ones taken out.
async fn graph_sync_files(state: &AppState, account_id: i64, rid: &str, doc: &DraftDoc) -> Result<()> {
    let msg = format!("{}/me/messages/{rid}", graph::base());
    let list = graph_call(state, account_id, Method::GET, &format!("{msg}/attachments?$select=id,name,isInline"), None, &[PREFER_IMMUTABLE]).await?;
    let on_server: Vec<(String, String)> = list["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| !a["isInline"].as_bool().unwrap_or(false))
        .filter_map(|a| Some((a["id"].as_str()?.to_string(), a["name"].as_str().unwrap_or_default().to_string())))
        .collect();
    let local = |name: &str| doc.attachments.iter().any(|f| f.name == name);
    for (aid, name) in &on_server {
        let keep = local(name) || (doc.kind == DraftKind::Forward && !doc.imported && !doc.dropped_attachments.contains(name));
        if !keep {
            graph_call(state, account_id, Method::DELETE, &format!("{msg}/attachments/{aid}"), None, &[PREFER_IMMUTABLE]).await?;
        }
    }
    for f in doc.attachments.iter().filter(|f| !on_server.iter().any(|(_, n)| *n == f.name)) {
        let data = state.db.with(|c| draft_files::for_send(c, f))?;
        if data.len() < crate::graph_send::INLINE_LIMIT {
            let body = crate::graph_send::file_attachment(f, &data);
            graph_call(state, account_id, Method::POST, &format!("{msg}/attachments"), Some(&body), &[PREFER_IMMUTABLE]).await?;
        } else {
            crate::graph_send::upload(state, account_id, &msg, f, &data).await?;
        }
    }
    Ok(())
}

/// Threading for a Gmail draft: a draft started elsewhere keeps its own; a reply started
/// here takes the original's (thread, In-Reply-To, References).
async fn gmail_threading(state: &AppState, row: &DraftRow, doc: &DraftDoc) -> Result<RemoteMeta> {
    if doc.imported {
        return Ok(row.meta.clone());
    }
    let Some(orig) = reference_remote(state, doc)?.filter(|_| doc.kind != DraftKind::Forward) else { return Ok(RemoteMeta::default()) };
    let v = gmail::get_message(state, row.account_id, &orig, "full").await?;
    let payload = &v["payload"];
    let message_id = gmail_send::header_of(payload, "Message-ID").or_else(|| gmail_send::header_of(payload, "Message-Id")).map(String::from);
    let references = match (gmail_send::header_of(payload, "References"), &message_id) {
        (Some(r), Some(id)) => Some(format!("{r} {id}")),
        (None, Some(id)) => Some(id.clone()),
        _ => None,
    };
    Ok(RemoteMeta { thread_id: v["threadId"].as_str().map(String::from), in_reply_to: message_id, references })
}

async fn gmail_push(state: &AppState, row: &DraftRow, doc: &DraftDoc) -> Result<(String, String)> {
    let a = row.account_id;
    let account = state
        .db
        .with(|c| db::list_accounts(c))?
        .into_iter()
        .find(|x| x.id == a)
        .ok_or_else(|| AppError::Other("unknown account".into()))?;
    let threading = gmail_threading(state, row, doc).await?;
    let mut files = Vec::new();
    for f in &doc.attachments {
        let data = state.db.with(|c| draft_files::for_send(c, f))?;
        files.push(gmail_send::Part { filename: f.name.clone(), mime: f.mime.clone(), data, content_id: None });
    }
    let (to, cc, bcc) = (addresses(&doc.to), addresses(&doc.cc), addresses(&doc.bcc));
    let raw = gmail_send::build(&gmail_send::Outgoing {
        from: gmail_send::format_address(account.display_name.as_deref(), &account.email),
        to: &to,
        cc: &cc,
        bcc: &bcc,
        subject: &doc.subject,
        text: doc.body.clone(),
        html: html_of(doc),
        in_reply_to: threading.in_reply_to.clone(),
        references: threading.references.clone(),
        inline: vec![],
        attachments: files,
    });
    let mut message = json!({ "raw": URL_SAFE_NO_PAD.encode(raw.as_bytes()) });
    if let Some(t) = &threading.thread_id {
        message["threadId"] = json!(t);
    }
    let base = gmail::base();
    let big = raw.len() > gmail_send::JSON_LIMIT;
    let meta = json!({ "message": { "threadId": threading.thread_id } });
    let create = || async {
        if big {
            gmail_send::upload_to(state, a, Method::POST, "/drafts", &meta, &raw).await
        } else {
            gmail::call(state, a, Method::POST, &format!("{base}/drafts"), Some(&json!({ "message": message }))).await
        }
    };
    let saved = match &row.remote_id {
        Some(rid) => {
            let updated = if big {
                gmail_send::upload_to(state, a, Method::PUT, &format!("/drafts/{rid}"), &meta, &raw).await
            } else {
                gmail::call(state, a, Method::PUT, &format!("{base}/drafts/{rid}"), Some(&json!({ "id": rid, "message": message }))).await
            };
            match updated {
                Err(AppError::Graph { status: 404, .. }) => create().await?,
                other => other?,
            }
        }
        None => create().await?,
    };
    let rid = saved["id"].as_str().ok_or_else(|| AppError::Other("Gmail returned a draft without an id".into()))?;
    Ok((rid.to_string(), saved["message"]["id"].as_str().unwrap_or_default().to_string()))
}

// ---------- delete and send ----------

/// Deletes a server draft (gone already is fine).
pub async fn delete_remote(state: &AppState, account_id: i64, rid: &str) -> Result<()> {
    let result = if is_google(state, account_id)? {
        gmail::call(state, account_id, Method::DELETE, &format!("{}/drafts/{rid}", gmail::base()), None).await
    } else {
        graph_call(state, account_id, Method::DELETE, &format!("{}/me/messages/{rid}", graph::base()), None, &[PREFER_IMMUTABLE]).await
    };
    match result {
        Ok(_) | Err(AppError::Graph { status: 404, .. }) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Sends a draft started elsewhere through its server copy, after putting the final
/// content there.
pub async fn send_server_copy(state: &AppState, account_id: i64, d: &Draft) -> Result<Value> {
    let _lock = state.drafts_lock.lock().await;
    let id = d.draft_id.ok_or_else(|| AppError::Other("not a draft".into()))?;
    let row = state.db.with(|c| drafts::get(c, id))?.ok_or_else(|| AppError::Graph { status: 400, message: "the draft is gone".into() })?;
    let doc = DraftDoc {
        to: d.to.join(", "),
        cc: d.cc.join(", "),
        bcc: d.bcc.join(", "),
        subject: d.subject.clone(),
        body: d.body.clone(),
        html: d.html.clone(),
        attachments: d.attachments.clone(),
        ..row.doc.clone()
    };
    let (rid, _) = push_doc(state, &row, &doc).await?;
    if is_google(state, account_id)? {
        gmail::call(state, account_id, Method::POST, &format!("{}/drafts/send", gmail::base()), Some(&json!({ "id": rid }))).await
    } else {
        graph_call(state, account_id, Method::POST, &format!("{}/me/messages/{rid}/send", graph::base()), Some(&json!({})), &[PREFER_IMMUTABLE]).await
    }
}

// ---------- pull ----------

/// A server draft, as pulled.
struct Pulled {
    to: String,
    cc: String,
    bcc: String,
    subject: String,
    html: String,
    meta: RemoteMeta,
    /// Its conversation (Graph conversationId, Gmail threadId).
    conversation: Option<String>,
    /// (name, mime, a way to fetch its bytes)
    files: Vec<(String, String, String)>,
}

/// Brings the account's server drafts in (see the module docs). Returns whether anything
/// changed here.
pub async fn pull(state: &AppState, account_id: i64) -> Result<bool> {
    let google = is_google(state, account_id)?;
    let listed = if google { gmail_list(state, account_id).await? } else { graph_list(state, account_id).await? };
    let Some(listed) = listed else { return Ok(false) };
    let _lock = state.drafts_lock.lock().await;
    let transient = state.transient_drafts.lock().expect("transient drafts").clone();
    let deleting = state.db.with(|c| crate::outbox::drafts_being_deleted(c, account_id))?;
    let locals = state.db.with(|c| drafts::with_remote(c, account_id))?;
    let mut changed = false;

    for (rid, version) in &listed {
        if transient.contains(rid) || deleting.contains(rid) {
            continue;
        }
        let local = locals.iter().find(|l| l.remote_id.as_deref() == Some(rid.as_str()));
        if local.is_some_and(|l| l.dirty || l.hidden || l.remote_version.as_deref() == Some(version.as_str())) {
            continue;
        }
        // One draft that can't be read mustn't hold up the others (it's tried again next sync).
        let pulled = if google { gmail_fetch(state, account_id, rid).await } else { graph_fetch(state, account_id, rid).await };
        let pulled = match pulled {
            Ok(Some(p)) => p,
            Ok(None) => continue,
            Err(e) => {
                log::warn!("couldn't bring in a server draft: {e}");
                continue;
            }
        };
        // Started here as a reply or forward: what it answers, and its files, stay as they are.
        let keep_files = local.is_some_and(|l| l.doc.kind != DraftKind::New && !l.doc.imported);
        let files = if keep_files {
            local.map(|l| l.doc.attachments.clone()).unwrap_or_default()
        } else {
            match fetch_files(state, account_id, google, local, &pulled.files).await {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("couldn't bring in a server draft's attachments: {e}");
                    continue;
                }
            }
        };
        let mut base = local.map(|l| l.doc.clone()).unwrap_or(DraftDoc { imported: true, ..Default::default() });
        // A reply written elsewhere to a conversation that's here shows with it.
        if base.conversation_id.is_none()
            && let Some(cid) = &pulled.conversation
            && state.db.with(|c| db::has_conversation(c, account_id, cid))? {
            base.conversation_id = Some(cid.clone());
        }
        let body = sanitize::html_to_text(&pulled.html);
        let doc = DraftDoc { to: pulled.to, cc: pulled.cc, bcc: pulled.bcc, subject: pulled.subject, html: pulled.html, body, attachments: files, ..base };
        state.db.with(|c| drafts::apply_remote(c, account_id, rid, version, &pulled.meta, &doc))?;
        changed = true;
    }

    // Gone from the server (sent or deleted elsewhere), and not changed here since.
    for l in locals.iter().filter(|l| !l.dirty && !l.hidden) {
        let rid = l.remote_id.as_deref().unwrap_or_default();
        if !listed.iter().any(|(r, _)| r == rid) {
            state.db.with(|c| drafts::delete(c, l.id, false))?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Files of a pulled draft: the local copy's where the name matches (no download for a
/// text-only edit), else downloaded.
async fn fetch_files(state: &AppState, account_id: i64, google: bool, local: Option<&DraftRow>, wanted: &[(String, String, String)]) -> Result<Vec<DraftFile>> {
    let mut out = Vec::new();
    for (name, mime, source) in wanted {
        if let Some(f) = local.and_then(|l| l.doc.attachments.iter().find(|f| f.name == *name)) {
            out.push(f.clone());
            continue;
        }
        let data = if google {
            let (msg, att) = source.split_once('\n').unwrap_or_default();
            gmail::attachment(state, account_id, msg, att).await?
        } else {
            let token = state.access_token(account_id).await?;
            graph::get_bytes(&state.http, &token, source).await?
        };
        match state.db.with(|c| draft_files::add(c, name, mime, &data)) {
            Ok(f) => out.push(f),
            Err(e) => log::warn!("a draft's attachment wasn't brought in: {e}"),
        }
    }
    Ok(out)
}

/// The server's drafts as (id, version). None when the list couldn't be read whole (then
/// nothing is taken as deleted).
async fn graph_list(state: &AppState, account_id: i64) -> Result<Option<Vec<(String, String)>>> {
    let mut url = format!("{}/me/mailFolders/drafts/messages?$select=id,lastModifiedDateTime&$top=100", graph::base());
    let mut out = Vec::new();
    for _ in 0..20 {
        let page = graph_call(state, account_id, Method::GET, &url, None, &[PREFER_IMMUTABLE]).await?;
        for m in page["value"].as_array().into_iter().flatten() {
            if let (Some(id), Some(v)) = (m["id"].as_str(), m["lastModifiedDateTime"].as_str()) {
                out.push((id.to_string(), v.to_string()));
            }
        }
        match page["@odata.nextLink"].as_str() {
            Some(next) => url = next.to_string(),
            None => return Ok(Some(out)),
        }
    }
    Ok(None)
}

fn graph_addresses(v: &Value) -> String {
    v.as_array().into_iter().flatten().filter_map(|r| r["emailAddress"]["address"].as_str()).collect::<Vec<_>>().join(", ")
}

async fn graph_fetch(state: &AppState, account_id: i64, rid: &str) -> Result<Option<Pulled>> {
    let base = graph::base();
    let m = match graph_call(
        state,
        account_id,
        Method::GET,
        &format!("{base}/me/messages/{rid}?$select=subject,toRecipients,ccRecipients,bccRecipients,body,conversationId"),
        None,
        &[PREFER_IMMUTABLE],
    )
    .await
    {
        Err(AppError::Graph { status: 404, .. }) => return Ok(None),
        other => other?,
    };
    let content = m["body"]["content"].as_str().unwrap_or_default();
    let html = if m["body"]["contentType"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("html")) {
        sanitize::import_draft_html(content)
    } else {
        sanitize::lines_to_html(content)
    };
    let atts = graph_call(state, account_id, Method::GET, &format!("{base}/me/messages/{rid}/attachments?$select=id,name,contentType,isInline"), None, &[PREFER_IMMUTABLE]).await?;
    let files = atts["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| !a["isInline"].as_bool().unwrap_or(false) && a["@odata.type"].as_str().is_none_or(|t| t.ends_with("fileAttachment")))
        .filter_map(|a| {
            let id = a["id"].as_str()?;
            Some((a["name"].as_str().unwrap_or("attachment").to_string(), a["contentType"].as_str().unwrap_or_default().to_string(), format!("{base}/me/messages/{rid}/attachments/{id}/$value")))
        })
        .collect();
    Ok(Some(Pulled {
        to: graph_addresses(&m["toRecipients"]),
        cc: graph_addresses(&m["ccRecipients"]),
        bcc: graph_addresses(&m["bccRecipients"]),
        subject: m["subject"].as_str().unwrap_or_default().to_string(),
        html,
        meta: RemoteMeta::default(),
        conversation: m["conversationId"].as_str().map(String::from),
        files,
    }))
}

async fn gmail_list(state: &AppState, account_id: i64) -> Result<Option<Vec<(String, String)>>> {
    let base = gmail::base();
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..20 {
        let url = match &token {
            Some(t) => format!("{base}/drafts?maxResults=100&pageToken={t}"),
            None => format!("{base}/drafts?maxResults=100"),
        };
        let page = gmail::call(state, account_id, Method::GET, &url, None).await?;
        for d in page["drafts"].as_array().into_iter().flatten() {
            if let (Some(id), Some(v)) = (d["id"].as_str(), d["message"]["id"].as_str()) {
                out.push((id.to_string(), v.to_string()));
            }
        }
        match page["nextPageToken"].as_str() {
            Some(t) => token = Some(t.to_string()),
            None => return Ok(Some(out)),
        }
    }
    Ok(None)
}

async fn gmail_fetch(state: &AppState, account_id: i64, rid: &str) -> Result<Option<Pulled>> {
    let v = match gmail::call(state, account_id, Method::GET, &format!("{}/drafts/{rid}?format=full", gmail::base()), None).await {
        Err(AppError::Graph { status: 404, .. }) => return Ok(None),
        other => other?,
    };
    let msg = &v["message"];
    let msg_id = msg["id"].as_str().unwrap_or_default().to_string();
    let payload = &msg["payload"];
    let h = |n: &str| gmail_send::header_of(payload, n).map(gmail::decode_words).unwrap_or_default();
    let list = |n: &str| gmail::parse_addresses(&h(n)).into_iter().map(|(_, a)| a).collect::<Vec<_>>().join(", ");
    let parts = gmail::collect_parts(payload);
    let html = match (&parts.html, &parts.text) {
        (Some((c, is_id, cs)), _) => sanitize::import_draft_html(&gmail::decode_charset(&gmail::content_bytes(state, account_id, &msg_id, c, *is_id).await?, cs)),
        (None, Some((c, is_id, cs))) => sanitize::lines_to_html(&gmail::decode_charset(&gmail::content_bytes(state, account_id, &msg_id, c, *is_id).await?, cs)),
        _ => String::new(),
    };
    let files = parts.attachments.iter().map(|a| (a.name.clone(), a.content_type.clone(), format!("{msg_id}\n{}", a.id))).collect();
    let header = |n: &str| gmail_send::header_of(payload, n).map(String::from);
    Ok(Some(Pulled {
        to: list("To"),
        cc: list("Cc"),
        bcc: list("Bcc"),
        subject: h("Subject"),
        html,
        meta: RemoteMeta { thread_id: msg["threadId"].as_str().map(String::from), in_reply_to: header("In-Reply-To"), references: header("References") },
        conversation: msg["threadId"].as_str().map(String::from),
        files,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_as_typed_become_a_list() {
        assert_eq!(addresses(" a@x.com, b@y.com; ,"), vec!["a@x.com", "b@y.com"]);
        assert_eq!(recipients("a@x.com")[0]["emailAddress"]["address"], "a@x.com");
        assert!(addresses("").is_empty());
    }

    #[test]
    fn a_draft_goes_up_with_the_html_it_would_be_sent_with() {
        let doc = DraftDoc { html: "<p><strong>Hi</strong></p>".into(), ..Default::default() };
        assert!(html_of(&doc).contains("<div><strong>Hi</strong></div>"));
        let plain = DraftDoc { body: "Hi\n\nBye".into(), ..Default::default() };
        assert!(html_of(&plain).contains("<p>Hi</p><p>Bye</p>"));
    }
}
