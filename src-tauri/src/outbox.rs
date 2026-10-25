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
    let not_before = (chrono::Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default())
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    Ok(conn.query_row(
        "INSERT INTO outbox (account_id, remote_id, op, not_before) VALUES (?1, ?2, ?3, ?4) RETURNING id",
        params![account_id, remote_id, serde_json::to_string(op)?, not_before],
        |r| r.get(0),
    )?)
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
pub fn reset_inflight(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE outbox SET status = 'pending' WHERE status = 'inflight'", [])?;
    Ok(())
}

pub fn status(conn: &Connection) -> Result<OutboxStatus> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'inflight')),
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
            // Nothing due now. If something is waiting out its grace period, sleep and retry.
            match state.db.with(|c| next_due_in(c))? {
                Some(wait) if wait <= Duration::from_secs(30) => {
                    tokio::time::sleep(wait + Duration::from_millis(20)).await;
                    continue;
                }
                _ => break,
            }
        };

        let result = execute(state, &row).await;
        state.db.with(|c| {
            match &result {
                Ok(()) => {
                    c.execute("DELETE FROM outbox WHERE id = ?1", [row.id])?;
                }
                // The message is gone on the server; nothing left to do.
                Err(AppError::Graph { status: 404, .. }) if !matches!(row.op, Op::Send(_)) => {
                    log::warn!("outbox op {} target vanished, dropping", row.id);
                    c.execute("DELETE FROM outbox WHERE id = ?1", [row.id])?;
                }
                Err(e) if is_permanent(e) || row.attempts + 1 >= MAX_ATTEMPTS => {
                    log::error!("outbox op {} failed permanently: {e}", row.id);
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
        emit_status(app, state);
        if result.is_err() && !is_permanent(result.as_ref().unwrap_err()) {
            // Transient failure: stop for now; the next kick or sync tick retries.
            break;
        }
    }
    if sent_any {
        // Pull the server's view (sent copies, moved folders) promptly.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = mail::sync_all(&app).await;
        });
    }
    Ok(())
}

fn is_permanent(e: &AppError) -> bool {
    matches!(e, AppError::Graph { status, .. } if (400..500).contains(status) && *status != 408 && *status != 429)
}

pub fn emit_status(app: &AppHandle, state: &AppState) {
    if let Ok(s) = state.db.with(|c| status(c)) {
        let _ = app.emit(EVENT_OUTBOX, s);
    }
}

async fn execute(state: &AppState, row: &Row) -> Result<()> {
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
        Op::Move { destination } => (Method::POST, format!("{}/move", msg_url(rid()?)), json!({ "destinationId": destination })),
        Op::Send(d) => send_request(base, row.remote_id.as_deref(), d)?,
    };
    mail::graph_call(state, row.account_id, method, &url, Some(&body), &[PREFER_IMMUTABLE]).await?;
    Ok(())
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
        let op = Op::Send(Draft { kind: DraftKind::ReplyAll, to: vec![], cc: vec!["a@b.c".into()], subject: String::new(), body: "hi".into() });
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
    fn builds_send_requests() {
        let d = Draft { kind: DraftKind::Forward, to: vec!["sam@x.com".into()], cc: vec![], subject: String::new(), body: "fyi <b>".into() };
        let (m, url, body) = send_request("https://g", Some("R1"), &d).unwrap();
        assert_eq!(m, Method::POST);
        assert_eq!(url, "https://g/me/messages/R1/forward");
        assert_eq!(body["toRecipients"][0]["emailAddress"]["address"], "sam@x.com");
        assert!(body["comment"].as_str().unwrap().contains("fyi &lt;b&gt;"));
        assert!(send_request("https://g", None, &Draft { kind: DraftKind::Reply, ..d }).is_err());
    }
}
