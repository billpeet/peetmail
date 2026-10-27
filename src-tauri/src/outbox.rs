//! Outbox: every remote mutation is applied to the local cache first, then queued
//! here and replayed to Graph by a background worker. The UI never waits on the
//! network, and undo is usually just deleting a row that hasn't been sent yet.

use std::collections::HashSet;
use std::time::Duration;

use reqwest::Method;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, Result};
use crate::graph::{self, PREFER_IMMUTABLE};
use crate::state::AppState;
use crate::{mail, sanitize};

/// Triage ops wait this long before going out, so a quick undo never touches the server.
pub const GRACE: Duration = Duration::from_secs(2);
const MAX_ATTEMPTS: i64 = 8;

pub const EVENT_OUTBOX: &str = "outbox-changed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Op {
    SetRead { value: bool },
    SetFlag { value: bool },
    /// `destination` is a Graph well-known folder name (inbox, archive, deleteditems) or folder id.
    Move { destination: String },
    Send(Draft),
    /// RSVP to a meeting; the outbox row's remote_id is the event's id.
    Respond { response: Rsvp },
    /// Create an event; the outbox row's remote_id is the local placeholder ("local:...")
    /// that's swapped for the real event once Graph returns it.
    CreateEvent(NewEvent),
    /// Edit an event (remote_id: the occurrence, or the series master).
    UpdateEvent { changes: crate::event_edit::EventChanges },
    /// Delete an event. `cancel`: you organise it and it has guests, so tell them
    /// (Graph's cancel with an optional message; Google sendUpdates=all).
    DeleteEvent { cancel: bool, comment: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub subject: String,
    /// Timed: UTC ISO instants. All-day: YYYY-MM-DD (end exclusive).
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    /// IANA zone for all-day events (their dates are local to it).
    pub time_zone: String,
    /// The rest of a full event (description, guests, show-as, reminder, privacy, repeat).
    #[serde(default, skip_serializing_if = "crate::event_edit::EventChanges::is_empty")]
    pub details: crate::event_edit::EventChanges,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Rsvp {
    Accept,
    Tentative,
    Decline,
}

impl Rsvp {
    /// Graph action segment: /me/events/{id}/{action}.
    fn action(self) -> &'static str {
        match self {
            Rsvp::Accept => "accept",
            Rsvp::Tentative => "tentativelyAccept",
            Rsvp::Decline => "decline",
        }
    }

    /// The event's `responseStatus.response` once this reply lands.
    pub fn status(self) -> &'static str {
        match self {
            Rsvp::Accept => "accepted",
            Rsvp::Tentative => "tentativelyAccepted",
            Rsvp::Decline => "declined",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DraftKind {
    New,
    Reply,
    ReplyAll,
    Forward,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub kind: DraftKind,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub subject: String,
    /// Plain text as typed; converted to HTML when sent.
    pub body: String,
    /// When the user scheduled it (UTC RFC 3339). None: sent after the undo delay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_at: Option<String>,
    /// Local id of the message replied to or forwarded, so a cancelled send can reopen
    /// the composer as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_message_id: Option<i64>,
}

/// A send waiting in the outbox (undo window or scheduled).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSend {
    pub id: i64,
    pub account_id: i64,
    /// When it goes out (UTC).
    pub send_at: String,
    pub draft: Draft,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxStatus {
    pub pending: i64,
    pub failed: i64,
    /// Most recent permanent failure, for a toast.
    pub last_error: Option<String>,
}

#[derive(Debug)]
struct Row {
    id: i64,
    account_id: i64,
    remote_id: Option<String>,
    op: Op,
    attempts: i64,
}

// ---------- storage ----------

pub fn enqueue(conn: &Connection, account_id: i64, remote_id: Option<&str>, op: &Op, delay: Duration) -> Result<i64> {
    // Use SQLite's clock, the same one `take_due` compares against. Rust's clock can run
    // ~15ms ahead of it on Windows, which made zero-delay ops look not-yet-due.
    let offset = format!("+{:.3} seconds", delay.as_secs_f64());
    Ok(conn.query_row(
        "INSERT INTO outbox (account_id, remote_id, op, not_before)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?4)) RETURNING id",
        params![account_id, remote_id, serde_json::to_string(op)?, offset],
        |r| r.get(0),
    )?)
}

/// Queues an op to run at an absolute time (UTC RFC 3339).
pub fn enqueue_at(conn: &Connection, account_id: i64, remote_id: Option<&str>, op: &Op, at: chrono::DateTime<chrono::Utc>) -> Result<i64> {
    // Same text format as strftime('%Y-%m-%dT%H:%M:%fZ'), since `take_due` compares strings.
    let at = at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    Ok(conn.query_row(
        "INSERT INTO outbox (account_id, remote_id, op, not_before) VALUES (?1, ?2, ?3, ?4) RETURNING id",
        params![account_id, remote_id, serde_json::to_string(op)?, at],
        |r| r.get(0),
    )?)
}

/// Sends that haven't gone out yet, soonest first. `scheduled_only` skips ones that are
/// just waiting out the undo delay.
pub fn queued_sends(conn: &Connection, scheduled_only: bool) -> Result<Vec<QueuedSend>> {
    let mut stmt = conn.prepare(
        "SELECT id, account_id, not_before, op FROM outbox
         WHERE status = 'pending' AND json_extract(op, '$.type') = 'send' ORDER BY not_before, id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, account_id, send_at, op) = row?;
        if let Op::Send(draft) = serde_json::from_str(&op)?
            && (!scheduled_only || draft.send_at.is_some()) {
            out.push(QueuedSend { id, account_id, send_at, draft });
        }
    }
    Ok(out)
}

/// Takes a send back out of the queue before it goes. None if it has already started
/// (or doesn't exist).
pub fn take_send(conn: &Connection, id: i64) -> Result<Option<QueuedSend>> {
    let Some(q) = queued_sends(conn, false)?.into_iter().find(|q| q.id == id) else { return Ok(None) };
    Ok(cancel(conn, id)?.then_some(q))
}

/// Deletes a queued op if it hasn't started. Returns true if it was cancelled.
pub fn cancel(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM outbox WHERE id = ?1 AND status = 'pending'", [id])? == 1)
}

/// Remote ids with queued or in-flight ops. Sync leaves these alone so a stale delta
/// can't undo a local change that hasn't reached the server yet.
pub fn busy_remote_ids(conn: &Connection, account_id: i64) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT remote_id FROM outbox WHERE account_id = ?1 AND remote_id IS NOT NULL AND status IN ('pending', 'inflight')",
    )?;
    let ids = stmt.query_map([account_id], |r| r.get(0))?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

/// Ops interrupted by a crash or quit go back in the queue.
/// Sends inside their undo window or going out right now. Scheduled sends don't count:
/// they wait for their time whether or not PeetMail restarts.
pub fn sends_in_progress(conn: &Connection) -> Result<usize> {
    let inflight: i64 = conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE status = 'inflight' AND json_extract(op, '$.type') = 'send'",
        [],
        |r| r.get(0),
    )?;
    let waiting = queued_sends(conn, false)?.iter().filter(|q| q.draft.send_at.is_none()).count();
    Ok(inflight as usize + waiting)
}

pub fn reset_inflight(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE outbox SET status = 'pending' WHERE status = 'inflight'", [])?;
    Ok(())
}

pub fn status(conn: &Connection) -> Result<OutboxStatus> {
    Ok(conn.query_row(
        // Sends still waiting for their time (undo delay, scheduled) aren't "changes
        // waiting to sync"; they have their own UI.
        "SELECT COUNT(*) FILTER (WHERE status = 'inflight' OR (status = 'pending' AND NOT (
                    json_extract(op, '$.type') = 'send' AND attempts = 0
                    AND not_before > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))),
                COUNT(*) FILTER (WHERE status = 'failed'),
                (SELECT last_error FROM outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 1)
         FROM outbox",
        [],
        |r| Ok(OutboxStatus { pending: r.get(0)?, failed: r.get(1)?, last_error: r.get(2)? }),
    )?)
}

fn take_due(conn: &Connection) -> Result<Option<Row>> {
    let row = conn
        .query_row(
            "SELECT id, account_id, remote_id, op, attempts FROM outbox
             WHERE status = 'pending' AND not_before <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             ORDER BY id LIMIT 1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?, r.get::<_, String>(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((id, account_id, remote_id, op, attempts)) = row else { return Ok(None) };
    conn.execute("UPDATE outbox SET status = 'inflight' WHERE id = ?1", [id])?;
    Ok(Some(Row { id, account_id, remote_id, op: serde_json::from_str(&op)?, attempts }))
}

fn next_due_in(conn: &Connection) -> Result<Option<Duration>> {
    let next: Option<String> = conn
        .query_row("SELECT MIN(not_before) FROM outbox WHERE status = 'pending'", [], |r| r.get(0))
        .optional()?
        .flatten();
    Ok(next.and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok()).map(|t| {
        let ms = (t.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_milliseconds().max(0);
        Duration::from_millis(ms as u64)
    }))
}

// ---------- worker ----------

/// Starts draining the queue unless a drain is already running.
pub fn kick(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(_guard) = state.outbox_lock.try_lock() else { return };
        if let Err(e) = drain(&app, &state).await {
            log::error!("outbox drain: {e}");
        }
    });
}

async fn drain(app: &AppHandle, state: &AppState) -> Result<()> {
    let mut sent_any = false;
    loop {
        let Some(row) = state.db.with(|c| take_due(c))? else {
            // Nothing due now. While anything is waiting (grace period, undo delay, a
            // scheduled send, a retry backoff), keep watching in short naps, so an op queued
            // meanwhile (a 2s triage op during a send's undo delay) doesn't wait for the
            // longer one, and scheduled sends go out on time.
            if std::mem::take(&mut sent_any) {
                sync_soon(app); // don't hold it back while a later op waits
            }
            match state.db.with(|c| next_due_in(c))? {
                Some(wait) => {
                    tokio::time::sleep(wait.min(Duration::from_secs(1)) + Duration::from_millis(20)).await;
                    continue;
                }
                None => break,
            }
        };

        let result = execute(state, &row).await;
        // Either way a creation changes the calendar: the real event, or the placeholder removed.
        let calendar_op = matches!(row.op, Op::CreateEvent(_) | Op::UpdateEvent { .. } | Op::DeleteEvent { .. });
        let calendar_touched = calendar_op && (result.is_ok() || result.as_ref().is_err_and(is_permanent));
        state.db.with(|c| {
            match &result {
                Ok(response) => {
                    if let (Op::CreateEvent(_), Some(local)) = (&row.op, row.remote_id.as_deref()) {
                        crate::calendar::finish_create(c, row.account_id, local, response)?;
                    }
                    c.execute("DELETE FROM outbox WHERE id = ?1", [row.id])?;
                }
                // The message is gone on the server; nothing left to do.
                Err(AppError::Graph { status: 404, .. }) if !matches!(row.op, Op::Send(_)) => {
                    log::warn!("outbox op {} target vanished, dropping", row.id);
                    c.execute("DELETE FROM outbox WHERE id = ?1", [row.id])?;
                }
                Err(e) if is_permanent(e) || row.attempts + 1 >= MAX_ATTEMPTS => {
                    log::error!("outbox op {} failed permanently: {e}", row.id);
                    // A rejected creation mustn't leave its placeholder in the calendar.
                    if let (Op::CreateEvent(_), Some(local)) = (&row.op, row.remote_id.as_deref()) {
                        crate::calendar::delete_event(c, row.account_id, local)?;
                    }
                    // A rejected edit or delete already shows locally: a full calendar resync
                    // puts the server's version back.
                    if matches!(row.op, Op::UpdateEvent { .. } | Op::DeleteEvent { .. }) {
                        c.execute("UPDATE calendar_sync SET delta_link = NULL WHERE account_id = ?1", [row.account_id])?;
                    }
                    c.execute(
                        "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?2 WHERE id = ?1",
                        params![row.id, e.to_string()],
                    )?;
                }
                Err(e) => {
                    let backoff = 2i64.pow(row.attempts.min(8) as u32).min(300);
                    log::warn!("outbox op {} failed ({e}), retrying in {backoff}s", row.id);
                    c.execute(
                        "UPDATE outbox SET status = 'pending', attempts = attempts + 1, last_error = ?2,
                           not_before = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3) WHERE id = ?1",
                        params![row.id, e.to_string(), format!("+{backoff} seconds")],
                    )?;
                }
            }
            Ok(())
        })?;
        sent_any |= result.is_ok();
        if calendar_touched {
            let _ = app.emit(crate::calendar::EVENT_CALENDAR_CHANGED, json!({ "accountId": row.account_id }));
        }
        emit_status(app, state);
        if result.is_err() && !is_permanent(result.as_ref().unwrap_err()) {
            // Transient failure: stop for now; the next kick or sync tick retries.
            break;
        }
    }
    if sent_any {
        sync_soon(app);
    }
    Ok(())
}

/// Pulls the server's view (sent copies, moved folders) promptly after ops went out.
fn sync_soon(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = mail::sync_all(&app).await;
    });
}

fn is_permanent(e: &AppError) -> bool {
    matches!(e, AppError::Graph { status, .. } if (400..500).contains(status) && *status != 408 && *status != 429)
}

pub fn emit_status(app: &AppHandle, state: &AppState) {
    if let Ok(s) = state.db.with(|c| status(c)) {
        let _ = app.emit(EVENT_OUTBOX, s);
    }
}

impl Op {
    /// The op's kind, for telemetry (never its content).
    pub fn kind(&self) -> &'static str {
        match self {
            Op::SetRead { .. } => "set_read",
            Op::SetFlag { .. } => "set_flag",
            Op::Move { .. } => "move",
            Op::Send(_) => "send",
            Op::Respond { .. } => "respond",
            Op::CreateEvent(_) => "create_event",
            Op::UpdateEvent { .. } => "update_event",
            Op::DeleteEvent { .. } => "delete_event",
        }
    }
}

/// Sends one op. Returns Graph's response body (the created event for CreateEvent).
async fn execute(state: &AppState, row: &Row) -> Result<Value> {
    use crate::telemetry::{attr, traced, Key};
    let attrs = vec![attr(Key::Op, row.op.kind()), attr(Key::Attempts, row.attempts + 1)];
    traced("outbox.op", attrs, execute_op(state, row)).await
}

async fn execute_op(state: &AppState, row: &Row) -> Result<Value> {
    if state.db.with(|c| crate::db::account_provider(c, row.account_id))? == "google" {
        return crate::gmail::execute(state, row.account_id, row.remote_id.as_deref(), &row.op).await;
    }
    let base = graph::base();
    let msg_url = |rid: &str| format!("{base}/me/messages/{rid}");
    let rid = || row.remote_id.as_deref().ok_or_else(|| AppError::Other("op has no target message".into()));
    let (method, url, body) = match &row.op {
        Op::SetRead { value } => (Method::PATCH, msg_url(rid()?), json!({ "isRead": value })),
        Op::SetFlag { value } => (
            Method::PATCH,
            msg_url(rid()?),
            json!({ "flag": { "flagStatus": if *value { "flagged" } else { "notFlagged" } } }),
        ),
        Op::Move { destination } => {
            let destination = if destination == crate::actions::SNOOZE_DEST {
                snooze_folder(state, row.account_id).await?
            } else {
                destination.clone()
            };
            (Method::POST, format!("{}/move", msg_url(rid()?)), json!({ "destinationId": destination }))
        }
        Op::Send(d) => send_request(base, row.remote_id.as_deref(), d)?,
        Op::Respond { response } => (
            Method::POST,
            format!("{base}/me/events/{}/{}", rid()?, response.action()),
            json!({ "sendResponse": true }),
        ),
        Op::CreateEvent(e) => (Method::POST, format!("{base}/me/events"), create_body(e)),
        Op::UpdateEvent { changes } => (Method::PATCH, format!("{base}/me/events/{}", rid()?), crate::event_edit::graph_body(changes, "UTC")),
        Op::DeleteEvent { cancel: true, comment } => (
            Method::POST,
            format!("{base}/me/events/{}/cancel", rid()?),
            json!({ "Comment": comment.clone().unwrap_or_default() }),
        ),
        Op::DeleteEvent { cancel: false, .. } => (Method::DELETE, format!("{base}/me/events/{}", rid()?), Value::Null),
    };
    let prefer: &[&str] = if matches!(row.op, Op::CreateEvent(_) | Op::UpdateEvent { .. }) {
        &[PREFER_IMMUTABLE, r#"outlook.timezone="UTC""#]
    } else {
        &[PREFER_IMMUTABLE]
    };
    mail::graph_call(state, row.account_id, method, &url, (!body.is_null()).then_some(&body), prefer).await
}

const SNOOZE_FOLDER_NAME: &str = "PeetMail Snoozed";

/// The server folder snoozed mail waits in: found by name, or created hidden (so other
/// mail apps don't list it). Its id is cached in settings.
async fn snooze_folder(state: &AppState, account_id: i64) -> Result<String> {
    let key = format!("snooze_folder:{account_id}");
    if let Some(id) = state.db.with(|c| crate::db::get_setting(c, &key))? {
        return Ok(id);
    }
    let base = graph::base();
    let list = mail::graph_call(state, account_id, Method::GET, &format!("{base}/me/mailFolders?includeHiddenFolders=true&$top=250"), None, &[PREFER_IMMUTABLE]).await?;
    let found = list["value"]
        .as_array()
        .and_then(|v| v.iter().find(|f| f["displayName"] == SNOOZE_FOLDER_NAME))
        .and_then(|f| f["id"].as_str())
        .map(String::from);
    let id = match found {
        Some(id) => id,
        None => {
            let url = format!("{base}/me/mailFolders");
            let hidden = json!({ "displayName": SNOOZE_FOLDER_NAME, "isHidden": true });
            let created = match mail::graph_call(state, account_id, Method::POST, &url, Some(&hidden), &[PREFER_IMMUTABLE]).await {
                Ok(v) => v,
                // Not every mailbox accepts hidden folders; a visible one still works.
                Err(AppError::Graph { status: 400, .. }) => {
                    mail::graph_call(state, account_id, Method::POST, &url, Some(&json!({ "displayName": SNOOZE_FOLDER_NAME })), &[PREFER_IMMUTABLE]).await?
                }
                Err(e) => return Err(e),
            };
            created["id"].as_str().map(String::from).ok_or_else(|| AppError::Other("created folder has no id".into()))?
        }
    };
    state.db.with(|c| crate::db::set_setting(c, &key, &id))?;
    Ok(id)
}

/// POST /me/events body. Timed events go in UTC; all-day events are midnights in the
/// user's own zone, which is how Graph defines them.
fn create_body(e: &NewEvent) -> Value {
    let (start, end) = if e.all_day {
        (
            json!({ "dateTime": format!("{}T00:00:00", e.start), "timeZone": e.time_zone }),
            json!({ "dateTime": format!("{}T00:00:00", e.end), "timeZone": e.time_zone }),
        )
    } else {
        let bare = |s: &str| s.trim_end_matches('Z').to_string();
        (json!({ "dateTime": bare(&e.start), "timeZone": "UTC" }), json!({ "dateTime": bare(&e.end), "timeZone": "UTC" }))
    };
    let mut body = json!({ "subject": e.subject, "start": start, "end": end, "isAllDay": e.all_day, "showAs": if e.all_day { "free" } else { "busy" } });
    if let Some(l) = &e.location {
        body["location"] = match e.details.location_email.as_deref().filter(|m| !m.is_empty()) {
            Some(email) => json!({ "displayName": l, "locationEmailAddress": email, "locationType": "conferenceRoom" }),
            None => json!({ "displayName": l }),
        };
    }
    // A full event's extra fields (the editor), in Graph's terms.
    if let Value::Object(extra) = crate::event_edit::graph_body(&e.details, &e.time_zone) {
        for (k, v) in extra {
            body[k] = v;
        }
    }
    body
}

fn recipients(list: &[String]) -> Value {
    Value::Array(list.iter().map(|a| json!({ "emailAddress": { "address": a } })).collect())
}

/// Graph request for a draft. Replies and forwards use the dedicated actions so Graph
/// threads them and quotes the original.
fn send_request(base: &str, reply_to: Option<&str>, d: &Draft) -> Result<(Method, String, Value)> {
    let html = sanitize::compose_html(&d.body);
    let target = || reply_to.ok_or_else(|| AppError::Other("reply has no original message".into()));
    Ok(match d.kind {
        DraftKind::New => (
            Method::POST,
            format!("{base}/me/sendMail"),
            json!({
                "message": {
                    "subject": d.subject,
                    "body": { "contentType": "HTML", "content": html },
                    "toRecipients": recipients(&d.to),
                    "ccRecipients": recipients(&d.cc),
                },
                "saveToSentItems": true,
            }),
        ),
        DraftKind::Reply | DraftKind::ReplyAll => {
            let action = if d.kind == DraftKind::Reply { "reply" } else { "replyAll" };
            let mut body = json!({ "comment": html });
            if !d.to.is_empty() || !d.cc.is_empty() {
                body["message"] = json!({ "toRecipients": recipients(&d.to), "ccRecipients": recipients(&d.cc) });
            }
            (Method::POST, format!("{base}/me/messages/{}/{action}", target()?), body)
        }
        DraftKind::Forward => (
            Method::POST,
            format!("{base}/me/messages/{}/forward", target()?),
            json!({ "comment": html, "toRecipients": recipients(&d.to) }),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Db};

    #[test]
    fn op_json_round_trips() {
        let op = Op::Send(Draft { kind: DraftKind::ReplyAll, to: vec![], cc: vec!["a@b.c".into()], subject: String::new(), body: "hi".into(), send_at: None, reference_message_id: Some(7) });
        let s = serde_json::to_string(&op).unwrap();
        assert!(s.contains(r#""type":"send""#));
        assert!(s.contains(r#""kind":"replyAll""#));
        assert_eq!(serde_json::from_str::<Op>(&s).unwrap(), op);
    }

    #[test]
    fn queue_respects_grace_cancel_and_busy_ids() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?;
            let now = enqueue(c, a.id, Some("m1"), &Op::SetRead { value: true }, Duration::ZERO)?;
            let later = enqueue(c, a.id, Some("m2"), &Op::Move { destination: "archive".into() }, Duration::from_secs(60))?;
            assert_eq!(busy_remote_ids(c, a.id)?, HashSet::from(["m1".to_string(), "m2".to_string()]));

            let due = take_due(c)?.expect("first op is due");
            assert_eq!(due.id, now);
            assert!(take_due(c)?.is_none(), "second op is still in its grace period");
            assert!(!cancel(c, now)?, "in-flight ops can't be cancelled");
            assert!(cancel(c, later)?);
            assert_eq!(status(c)?.pending, 1);

            reset_inflight(c)?;
            assert_eq!(take_due(c)?.map(|r| r.id), Some(now));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn sends_wait_in_the_queue_until_due_and_can_be_taken_back() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let draft = |send_at: Option<&str>| Draft {
                kind: DraftKind::New, to: vec!["p@x.com".into()], cc: vec![], subject: "Hi".into(), body: "b".into(),
                send_at: send_at.map(String::from), reference_message_id: None,
            };
            let later = chrono::Utc::now() + chrono::Duration::hours(20);
            let undo_window = enqueue(c, a, None, &Op::Send(draft(None)), Duration::from_secs(10))?;
            let scheduled = enqueue_at(c, a, None, &Op::Send(draft(Some(&later.to_rfc3339()))), later)?;
            assert!(take_due(c)?.is_none(), "nothing is due yet");
            assert_eq!(status(c)?.pending, 0, "waiting sends aren't unsynced changes");

            let all = queued_sends(c, false)?;
            assert_eq!(all.iter().map(|q| q.id).collect::<Vec<_>>(), vec![undo_window, scheduled]);
            assert_eq!(queued_sends(c, true)?.iter().map(|q| q.id).collect::<Vec<_>>(), vec![scheduled]);
            assert!(all[1].send_at.starts_with(&later.format("%Y-%m-%dT%H:%M").to_string()));
            assert_eq!(sends_in_progress(c)?, 1, "the undo-window send, not the scheduled one");

            let back = take_send(c, undo_window)?.expect("still queued");
            assert_eq!(back.draft.subject, "Hi");
            assert!(take_send(c, undo_window)?.is_none(), "already taken");
            assert_eq!(sends_in_progress(c)?, 0);

            // Once it's in flight it can't be taken back.
            c.execute("UPDATE outbox SET not_before = '2000-01-01T00:00:00.000Z' WHERE id = ?1", [scheduled])?;
            assert_eq!(take_due(c)?.map(|r| r.id), Some(scheduled));
            assert_eq!(sends_in_progress(c)?, 1, "a send going out right now counts");
            assert!(take_send(c, scheduled)?.is_none());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn create_event_bodies() {
        let timed = NewEvent {
            subject: "Lunch".into(), start: "2026-10-30T02:00:00Z".into(), end: "2026-10-30T02:30:00Z".into(),
            all_day: false, location: Some("Café".into()), time_zone: "Australia/Sydney".into(), details: Default::default(),
        };
        let b = create_body(&timed);
        assert_eq!(b["start"], json!({ "dateTime": "2026-10-30T02:00:00", "timeZone": "UTC" }));
        assert_eq!(b["location"]["displayName"], "Café");
        let all_day = NewEvent { start: "2026-11-06".into(), end: "2026-11-07".into(), all_day: true, location: None, ..timed };
        let b = create_body(&all_day);
        assert_eq!(b["start"], json!({ "dateTime": "2026-11-06T00:00:00", "timeZone": "Australia/Sydney" }));
        assert_eq!(b["isAllDay"], true);
        assert!(b.get("location").is_none());
    }

    #[test]
    fn rsvp_ops_round_trip() {
        let op = Op::Respond { response: Rsvp::Tentative };
        let s = serde_json::to_string(&op).unwrap();
        assert_eq!(s, r#"{"type":"respond","response":"tentative"}"#);
        assert_eq!(serde_json::from_str::<Op>(&s).unwrap(), op);
        assert_eq!(Rsvp::Tentative.action(), "tentativelyAccept");
        assert_eq!(Rsvp::Decline.status(), "declined");
    }

    #[test]
    fn builds_send_requests() {
        let d = Draft { kind: DraftKind::Forward, to: vec!["sam@x.com".into()], cc: vec![], subject: String::new(), body: "fyi <b>".into(), send_at: None, reference_message_id: None };
        let (m, url, body) = send_request("https://g", Some("R1"), &d).unwrap();
        assert_eq!(m, Method::POST);
        assert_eq!(url, "https://g/me/messages/R1/forward");
        assert_eq!(body["toRecipients"][0]["emailAddress"]["address"], "sam@x.com");
        assert!(body["comment"].as_str().unwrap().contains("fyi &lt;b&gt;"));
        assert!(send_request("https://g", None, &Draft { kind: DraftKind::Reply, ..d }).is_err());
    }
}
