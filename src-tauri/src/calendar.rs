//! Calendar: delta sync of `calendarView` over a rolling window, and event queries.
//!
//! `calendarView` returns occurrences (recurring series arrive expanded), which is what a
//! day/week view needs. Times are requested in UTC (`Prefer: outlook.timezone="UTC"`);
//! timed events are stored as UTC instants, all-day events as plain dates.

use std::collections::HashSet;

use chrono::{Duration, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

use crate::error::{AppError, Result};
use crate::graph::{self, PREFER_IMMUTABLE};
use crate::mail;
use crate::state::AppState;

pub const EVENT_CALENDAR_CHANGED: &str = "calendar-changed";

/// The synced window around today.
const WINDOW_BACK_DAYS: i64 = 30;
const WINDOW_AHEAD_DAYS: i64 = 120;
/// Start over with a fresh window once the current one covers less than this around today.
const MIN_BACK_DAYS: i64 = 14;
const MIN_AHEAD_DAYS: i64 = 90;

const PREFER_UTC: &str = r#"outlook.timezone="UTC""#;
const PAGE_SIZE: &str = "odata.maxpagesize=100";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub account_id: i64,
    pub remote_id: String,
    pub subject: String,
    /// UTC ISO instant, or YYYY-MM-DD for all-day events.
    pub start_at: String,
    /// Exclusive end: UTC ISO instant, or YYYY-MM-DD for all-day events.
    pub end_at: String,
    pub is_all_day: bool,
    pub location: Option<String>,
    pub organizer_name: Option<String>,
    pub organizer_address: Option<String>,
    pub attendees: Value,
    pub response: Option<String>,
    pub is_organizer: bool,
    pub is_cancelled: bool,
    pub show_as: Option<String>,
    pub join_url: Option<String>,
    pub web_link: Option<String>,
    pub preview: String,
}

/// An event as parsed from Graph (no local id yet).
#[derive(Debug, Clone, PartialEq)]
pub struct EventUpsert {
    pub remote_id: String,
    pub subject: String,
    pub start_at: String,
    pub end_at: String,
    pub is_all_day: bool,
    pub location: Option<String>,
    pub organizer_name: Option<String>,
    pub organizer_address: Option<String>,
    pub attendees_json: String,
    pub response: Option<String>,
    pub is_organizer: bool,
    pub is_cancelled: bool,
    pub show_as: Option<String>,
    pub join_url: Option<String>,
    pub web_link: Option<String>,
    pub preview: String,
    /// singleInstance | occurrence | exception | seriesMaster
    pub event_type: String,
    pub series_master_id: Option<String>,
    /// False for bare items (only id/start/end, e.g. occurrences of a series): their details
    /// come from the series master, or are fetched separately.
    pub has_details: bool,
}

// ---------- parsing ----------

/// "2026-10-27T03:00:00.0000000" (+ timeZone "UTC") -> "2026-10-27T03:00:00Z".
fn utc_instant(v: &Value) -> Option<String> {
    let dt = v.get("dateTime")?.as_str()?;
    let tz = v.get("timeZone").and_then(Value::as_str).unwrap_or("UTC");
    if tz != "UTC" {
        log::warn!("event time in {tz}, expected UTC; treating as UTC");
    }
    let base = dt.split('.').next()?.trim_end_matches('Z');
    (base.len() == 19).then(|| format!("{base}Z"))
}

fn date_part(v: &Value) -> Option<String> {
    let dt = v.get("dateTime")?.as_str()?;
    NaiveDate::parse_from_str(dt.get(..10)?, "%Y-%m-%d").ok().map(|d| d.to_string())
}

pub fn parse_event(v: &Value) -> Option<EventUpsert> {
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(String::from);
    // Bare delta items carry neither; every full event has at least an organizer.
    let has_details = v.get("subject").is_some() || v.get("organizer").is_some();
    let is_all_day = v.get("isAllDay").and_then(Value::as_bool).unwrap_or(false);
    let (start_at, end_at) = if is_all_day {
        (date_part(&v["start"])?, date_part(&v["end"])?)
    } else {
        (utc_instant(&v["start"])?, utc_instant(&v["end"])?)
    };
    let attendees: Vec<Value> = v["attendees"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            json!({
                "name": a.pointer("/emailAddress/name"),
                "address": a.pointer("/emailAddress/address"),
                "response": a.pointer("/status/response"),
                "type": a.get("type"),
            })
        })
        .collect();
    Some(EventUpsert {
        remote_id: s("/id")?,
        subject: s("/subject").unwrap_or_default(),
        start_at,
        end_at,
        is_all_day,
        location: s("/location/displayName").filter(|l| !l.trim().is_empty()),
        organizer_name: s("/organizer/emailAddress/name"),
        organizer_address: s("/organizer/emailAddress/address"),
        attendees_json: Value::Array(attendees).to_string(),
        response: s("/responseStatus/response"),
        is_organizer: v.get("isOrganizer").and_then(Value::as_bool).unwrap_or(false),
        is_cancelled: v.get("isCancelled").and_then(Value::as_bool).unwrap_or(false),
        show_as: s("/showAs"),
        join_url: s("/onlineMeeting/joinUrl"),
        web_link: s("/webLink"),
        preview: s("/bodyPreview").unwrap_or_default(),
        event_type: s("/type").unwrap_or_else(|| "singleInstance".into()),
        series_master_id: s("/seriesMasterId"),
        has_details,
    })
}

// ---------- storage ----------

/// Inserts or updates an event. A bare item (no details) updates times and type but never
/// wipes details already stored for that event.
pub fn upsert_event(conn: &Connection, account_id: i64, e: &EventUpsert) -> Result<()> {
    conn.execute(
        "INSERT INTO events (account_id, remote_id, subject, start_at, end_at, is_all_day, location, organizer_name,
                             organizer_address, attendees_json, response, is_organizer, is_cancelled, show_as,
                             join_url, web_link, preview, event_type, series_master_id, has_details)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT (account_id, remote_id) DO UPDATE SET
           start_at = excluded.start_at, end_at = excluded.end_at, is_all_day = excluded.is_all_day,
           is_cancelled = excluded.is_cancelled, event_type = excluded.event_type,
           series_master_id = COALESCE(excluded.series_master_id, series_master_id),
           subject           = CASE WHEN excluded.has_details THEN excluded.subject ELSE subject END,
           location          = CASE WHEN excluded.has_details THEN excluded.location ELSE location END,
           organizer_name    = CASE WHEN excluded.has_details THEN excluded.organizer_name ELSE organizer_name END,
           organizer_address = CASE WHEN excluded.has_details THEN excluded.organizer_address ELSE organizer_address END,
           attendees_json    = CASE WHEN excluded.has_details THEN excluded.attendees_json ELSE attendees_json END,
           response          = CASE WHEN excluded.has_details THEN excluded.response ELSE response END,
           is_organizer      = CASE WHEN excluded.has_details THEN excluded.is_organizer ELSE is_organizer END,
           show_as           = CASE WHEN excluded.has_details THEN excluded.show_as ELSE show_as END,
           join_url          = CASE WHEN excluded.has_details THEN excluded.join_url ELSE join_url END,
           web_link          = CASE WHEN excluded.has_details THEN excluded.web_link ELSE web_link END,
           preview           = CASE WHEN excluded.has_details THEN excluded.preview ELSE preview END,
           has_details       = MAX(has_details, excluded.has_details)",
        params![
            account_id, e.remote_id, e.subject, e.start_at, e.end_at, e.is_all_day, e.location, e.organizer_name,
            e.organizer_address, e.attendees_json, e.response, e.is_organizer, e.is_cancelled, e.show_as,
            e.join_url, e.web_link, e.preview, e.event_type, e.series_master_id, e.has_details
        ],
    )?;
    Ok(())
}

/// Events whose details still need fetching: series masters that bare occurrences point at
/// but we don't have, and bare items that aren't part of a series.
fn missing_details(conn: &Connection, account_id: i64, limit: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id FROM (
           SELECT DISTINCT e.series_master_id AS id FROM events e
           WHERE e.account_id = ?1 AND e.has_details = 0 AND e.series_master_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM events m WHERE m.account_id = ?1 AND m.remote_id = e.series_master_id AND m.has_details = 1)
           UNION
           SELECT remote_id FROM events WHERE account_id = ?1 AND has_details = 0 AND series_master_id IS NULL
         ) LIMIT ?2",
    )?;
    let ids = stmt.query_map(params![account_id, limit], |r| r.get(0))?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

pub fn delete_event(conn: &Connection, account_id: i64, remote_id: &str) -> Result<()> {
    conn.execute("DELETE FROM events WHERE account_id = ?1 AND remote_id = ?2", params![account_id, remote_id])?;
    Ok(())
}

const EVENT_COLS: &str = "id, account_id, remote_id, subject, start_at, end_at, is_all_day, location, organizer_name,
    organizer_address, attendees_json, response, is_organizer, is_cancelled, show_as, join_url, web_link, preview";

fn event_from_row(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    let attendees: String = r.get(10)?;
    Ok(Event {
        id: r.get(0)?,
        account_id: r.get(1)?,
        remote_id: r.get(2)?,
        subject: r.get(3)?,
        start_at: r.get(4)?,
        end_at: r.get(5)?,
        is_all_day: r.get(6)?,
        location: r.get(7)?,
        organizer_name: r.get(8)?,
        organizer_address: r.get(9)?,
        attendees: serde_json::from_str(&attendees).unwrap_or_default(),
        response: r.get(11)?,
        is_organizer: r.get(12)?,
        is_cancelled: r.get(13)?,
        show_as: r.get(14)?,
        join_url: r.get(15)?,
        web_link: r.get(16)?,
        preview: r.get(17)?,
    })
}

/// Events overlapping a range. Timed events are compared on UTC instants `[from, to)`;
/// all-day events on local dates `[from_date, to_date)`, so they land on the right day
/// in any time zone. Cancelled events are excluded.
pub fn list_events(conn: &Connection, from: &str, to: &str, from_date: &str, to_date: &str) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {EVENT_COLS} FROM event_view
         WHERE is_cancelled = 0 AND (
           (is_all_day = 0 AND start_at < ?2 AND end_at > ?1) OR
           (is_all_day = 1 AND start_at < ?4 AND end_at > ?3))
         ORDER BY is_all_day DESC, start_at, end_at DESC"
    ))?;
    let rows = stmt.query_map(params![from, to, from_date, to_date], event_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn event_by_remote(conn: &Connection, account_id: i64, remote_id: &str) -> Result<Option<Event>> {
    Ok(conn
        .query_row(
            &format!("SELECT {EVENT_COLS} FROM event_view WHERE account_id = ?1 AND remote_id = ?2"),
            params![account_id, remote_id],
            event_from_row,
        )
        .optional()?)
}

struct SyncState {
    delta_link: Option<String>,
    window_start: String,
    window_end: String,
}

fn sync_state(conn: &Connection, account_id: i64) -> Result<Option<SyncState>> {
    Ok(conn
        .query_row(
            "SELECT delta_link, window_start, window_end FROM calendar_sync WHERE account_id = ?1",
            [account_id],
            |r| Ok(SyncState { delta_link: r.get(0)?, window_start: r.get(1)?, window_end: r.get(2)? }),
        )
        .optional()?)
}

fn save_sync_state(conn: &Connection, account_id: i64, s: &SyncState) -> Result<()> {
    conn.execute(
        "INSERT INTO calendar_sync (account_id, delta_link, window_start, window_end) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (account_id) DO UPDATE SET delta_link = excluded.delta_link,
           window_start = excluded.window_start, window_end = excluded.window_end",
        params![account_id, s.delta_link, s.window_start, s.window_end],
    )?;
    Ok(())
}

// ---------- sync ----------

fn fresh_window() -> (String, String) {
    let today = Utc::now().date_naive();
    let fmt = |d: NaiveDate| format!("{d}T00:00:00Z");
    (fmt(today - Duration::days(WINDOW_BACK_DAYS)), fmt(today + Duration::days(WINDOW_AHEAD_DAYS)))
}

/// True when the stored window no longer covers enough around today.
fn window_is_stale(start: &str, end: &str) -> bool {
    let now = Utc::now();
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).map(|d| d.with_timezone(&Utc));
    match (parse(start), parse(end)) {
        (Ok(s), Ok(e)) => s > now - Duration::days(MIN_BACK_DAYS) || e < now + Duration::days(MIN_AHEAD_DAYS),
        _ => true,
    }
}

fn initial_url(start: &str, end: &str) -> String {
    let base = format!("{}/me/calendarView/delta", graph::base());
    Url::parse_with_params(&base, &[("startDateTime", start), ("endDateTime", end)]).expect("valid url").to_string()
}

/// Brings the account's events up to date. A full sync (first run, new window, or an
/// expired delta link) sweeps away events the server no longer reports.
pub async fn sync_account(app: &AppHandle, state: &AppState, account_id: i64) -> Result<()> {
    let stored = state.db.with(|c| sync_state(c, account_id))?;
    let mut sync = match stored {
        Some(s) if !window_is_stale(&s.window_start, &s.window_end) => s,
        _ => {
            let (window_start, window_end) = fresh_window();
            SyncState { delta_link: None, window_start, window_end }
        }
    };

    let mut restarted = false;
    'full: loop {
        let full = sync.delta_link.is_none();
        let mut url = sync.delta_link.clone().unwrap_or_else(|| initial_url(&sync.window_start, &sync.window_end));
        let mut seen: HashSet<String> = HashSet::new();
        let mut changed = false;
        loop {
            let page = match mail::graph_call(state, account_id, reqwest::Method::GET, &url, None, &[PREFER_IMMUTABLE, PREFER_UTC, PAGE_SIZE]).await {
                Ok(p) => p,
                Err(AppError::Graph { status: 410, .. }) if !restarted => {
                    log::warn!("calendar delta expired for account {account_id}, resyncing");
                    restarted = true;
                    sync.delta_link = None;
                    continue 'full;
                }
                Err(e) => return Err(e),
            };
            let items = page["value"].as_array().cloned().unwrap_or_default();
            if !items.is_empty() {
                changed = true;
                state.db.with(|c| {
                    // Events with an unsent RSVP keep their local answer until it reaches the server.
                    let busy = crate::outbox::busy_remote_ids(c, account_id)?;
                    let tx = c.transaction()?;
                    for item in &items {
                        let Some(id) = item["id"].as_str() else { continue };
                        if busy.contains(id) {
                            seen.insert(id.to_string());
                            continue;
                        }
                        if item.get("@removed").is_some() {
                            delete_event(&tx, account_id, id)?;
                        } else if let Some(e) = parse_event(item) {
                            seen.insert(e.remote_id.clone());
                            upsert_event(&tx, account_id, &e)?;
                        }
                    }
                    tx.commit()?;
                    Ok(())
                })?;
            }
            if let Some(next) = page["@odata.nextLink"].as_str() {
                url = next.to_string();
                continue;
            }
            sync.delta_link = page["@odata.deltaLink"].as_str().map(String::from);
            break;
        }

        state.db.with(|c| {
            if full {
                // Anything the full listing didn't mention is gone (or now outside the window).
                // Series masters are kept while an occurrence still points at them.
                let mut stmt = c.prepare("SELECT remote_id FROM events WHERE account_id = ?1 AND event_type <> 'seriesMaster'")?;
                let stale: Vec<String> = stmt
                    .query_map([account_id], |r| r.get::<_, String>(0))?
                    .filter_map(|r| r.ok())
                    .filter(|id| !seen.contains(id))
                    .collect();
                for id in &stale {
                    delete_event(c, account_id, id)?;
                }
                changed |= !stale.is_empty();
                c.execute(
                    "DELETE FROM events WHERE account_id = ?1 AND event_type = 'seriesMaster'
                       AND remote_id NOT IN (SELECT series_master_id FROM events WHERE account_id = ?1 AND series_master_id IS NOT NULL)",
                    [account_id],
                )?;
            }
            save_sync_state(c, account_id, &sync)
        })?;
        changed |= hydrate(state, account_id).await?;
        if changed {
            let _ = app.emit(EVENT_CALENDAR_CHANGED, json!({ "accountId": account_id }));
        }
        return Ok(());
    }
}

/// Fetches full details for series masters and bare events we only know the times of.
/// Bounded per sync; anything left over is picked up next time.
async fn hydrate(state: &AppState, account_id: i64) -> Result<bool> {
    const PER_SYNC: i64 = 100;
    let ids = state.db.with(|c| missing_details(c, account_id, PER_SYNC))?;
    let mut changed = false;
    for id in ids {
        let url = format!("{}/me/events/{id}", graph::base());
        match mail::graph_call(state, account_id, reqwest::Method::GET, &url, None, &[PREFER_IMMUTABLE, PREFER_UTC]).await {
            Ok(v) => {
                if let Some(e) = parse_event(&v) {
                    state.db.with(|c| upsert_event(c, account_id, &e))?;
                    changed = true;
                }
            }
            Err(AppError::Graph { status: 404, .. }) => {
                // Gone on the server; stop asking. Its occurrences keep their times.
                log::info!("event {id} not found while fetching details");
                state.db.with(|c| {
                    c.execute(
                        "UPDATE events SET has_details = 1 WHERE account_id = ?1 AND remote_id = ?2",
                        params![account_id, id],
                    )?;
                    Ok(())
                })?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(changed)
}

// ---------- invites ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    /// meetingRequest, meetingCancelled, meetingAccepted, ... (only requests get RSVP buttons).
    pub meeting_message_type: Option<String>,
    /// newMeetingRequest | fullUpdate | informationalUpdate | silentUpdate | outdated | ...
    pub meeting_request_type: Option<String>,
    /// For updates that moved the meeting: where it used to be (UTC instants / text).
    pub previous_start: Option<String>,
    pub previous_end: Option<String>,
    pub previous_location: Option<String>,
    pub event: Event,
}

/// The calendar event behind a meeting-invite message (cached into `events`), or None for
/// ordinary mail.
pub async fn invite_for_message(state: &AppState, message_id: i64) -> Result<Option<Invite>> {
    let (account_id, remote_id) = state
        .db
        .with(|c| crate::db::message_remote(c, message_id))?
        .ok_or_else(|| AppError::Other("message not found".into()))?;
    // No $select: an updated invite (eventMessageRequest) also carries meetingRequestType and
    // previousStart/End/Location, which a base-type select would drop.
    let url = format!("{}/me/messages/{remote_id}?$expand=microsoft.graph.eventMessage/event", graph::base());
    let v = mail::graph_call(state, account_id, reqwest::Method::GET, &url, None, &[PREFER_IMMUTABLE, PREFER_UTC]).await?;
    let Some(parsed) = v.get("event").and_then(parse_event) else { return Ok(None) };
    let event = state.db.with(|c| {
        // A queued RSVP wins over the server's not-yet-updated copy.
        let busy = crate::outbox::busy_remote_ids(c, account_id)?;
        if !busy.contains(&parsed.remote_id) || event_by_remote(c, account_id, &parsed.remote_id)?.is_none() {
            upsert_event(c, account_id, &parsed)?;
        }
        event_by_remote(c, account_id, &parsed.remote_id)?.ok_or_else(|| AppError::Other("event vanished".into()))
    })?;
    let previous = |k: &str| v.get(k).filter(|p| !p.is_null()).and_then(utc_instant);
    Ok(Some(Invite {
        meeting_message_type: v["meetingMessageType"].as_str().map(String::from),
        meeting_request_type: v["meetingRequestType"].as_str().map(String::from),
        previous_start: previous("previousStartDateTime"),
        previous_end: previous("previousEndDateTime"),
        previous_location: v.pointer("/previousLocation/displayName").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from),
        event,
    }))
}

/// Records an RSVP locally and queues it for Graph.
pub fn respond(conn: &Connection, account_id: i64, event_remote_id: &str, response: crate::outbox::Rsvp) -> Result<()> {
    conn.execute(
        "UPDATE events SET response = ?3 WHERE account_id = ?1 AND remote_id = ?2",
        params![account_id, event_remote_id, response.status()],
    )?;
    crate::outbox::enqueue(
        conn,
        account_id,
        Some(event_remote_id),
        &crate::outbox::Op::Respond { response },
        std::time::Duration::ZERO,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Db};

    fn timed(id: &str, start: &str, end: &str) -> Value {
        json!({
            "id": id, "subject": format!("Event {id}"), "isAllDay": false,
            "start": { "dateTime": format!("{start}.0000000"), "timeZone": "UTC" },
            "end": { "dateTime": format!("{end}.0000000"), "timeZone": "UTC" },
            "location": { "displayName": "Room 4" },
            "organizer": { "emailAddress": { "name": "Sam", "address": "sam@x.com" } },
            "attendees": [{ "emailAddress": { "name": "Boris", "address": "b@x.com" }, "status": { "response": "accepted" }, "type": "required" }],
            "responseStatus": { "response": "accepted" },
            "onlineMeeting": { "joinUrl": "https://teams.example/join/1" },
        })
    }

    #[test]
    fn parses_timed_and_all_day_events() {
        let e = parse_event(&timed("e1", "2026-10-27T03:00:00", "2026-10-27T03:30:00")).unwrap();
        assert_eq!(e.start_at, "2026-10-27T03:00:00Z");
        assert_eq!(e.end_at, "2026-10-27T03:30:00Z");
        assert_eq!(e.location.as_deref(), Some("Room 4"));
        assert_eq!(e.join_url.as_deref(), Some("https://teams.example/join/1"));
        assert!(e.attendees_json.contains("accepted"));

        let all_day = parse_event(&json!({
            "id": "e2", "subject": "Offsite", "isAllDay": true,
            "start": { "dateTime": "2026-10-30T00:00:00.0000000", "timeZone": "UTC" },
            "end": { "dateTime": "2026-10-31T00:00:00.0000000", "timeZone": "UTC" },
        }))
        .unwrap();
        assert_eq!((all_day.start_at.as_str(), all_day.end_at.as_str()), ("2026-10-30", "2026-10-31"));
        assert!(parse_event(&json!({ "id": "bad" })).is_none());
    }

    #[test]
    fn lists_events_overlapping_a_range() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            for (id, s, e) in [
                ("before", "2026-10-26T20:00:00", "2026-10-26T21:00:00"),
                ("spans-start", "2026-10-26T22:30:00", "2026-10-27T00:30:00"),
                ("inside", "2026-10-27T03:00:00", "2026-10-27T04:00:00"),
                ("after", "2026-10-28T00:00:00", "2026-10-28T01:00:00"),
            ] {
                upsert_event(c, a, &parse_event(&timed(id, s, e)).unwrap())?;
            }
            let mut offsite = parse_event(&timed("offsite", "2026-10-27T00:00:00", "2026-10-28T00:00:00")).unwrap();
            offsite.is_all_day = true;
            offsite.start_at = "2026-10-27".into();
            offsite.end_at = "2026-10-28".into();
            upsert_event(c, a, &offsite)?;
            let mut cancelled = parse_event(&timed("cancelled", "2026-10-27T05:00:00", "2026-10-27T06:00:00")).unwrap();
            cancelled.is_cancelled = true;
            upsert_event(c, a, &cancelled)?;

            // A local day of 27 Oct in UTC+11 is [26 Oct 13:00Z, 27 Oct 13:00Z).
            let got = list_events(c, "2026-10-26T13:00:00Z", "2026-10-27T13:00:00Z", "2026-10-27", "2026-10-28")?;
            let ids: Vec<&str> = got.iter().map(|e| e.remote_id.as_str()).collect();
            assert_eq!(ids, vec!["offsite", "before", "spans-start", "inside"]);

            delete_event(c, a, "inside")?;
            assert!(event_by_remote(c, a, "inside")?.is_none());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn respond_updates_locally_and_queues_the_reply() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let mut e = parse_event(&timed("inv", "2026-10-27T03:00:00", "2026-10-27T04:00:00")).unwrap();
            e.response = Some("notResponded".into());
            upsert_event(c, a, &e)?;
            respond(c, a, "inv", crate::outbox::Rsvp::Accept)?;
            assert_eq!(event_by_remote(c, a, "inv")?.unwrap().response.as_deref(), Some("accepted"));
            assert!(crate::outbox::busy_remote_ids(c, a)?.contains("inv"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn bare_occurrences_take_details_from_their_series_master() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let bare = |id: &str, start: &str, end: &str| {
                json!({
                    "id": id, "type": "occurrence", "seriesMasterId": "master",
                    "start": { "dateTime": format!("{start}.0000000"), "timeZone": "UTC" },
                    "end": { "dateTime": format!("{end}.0000000"), "timeZone": "UTC" },
                })
            };
            let occ = parse_event(&bare("occ1", "2026-10-27T22:00:00", "2026-10-27T22:15:00")).unwrap();
            assert!(!occ.has_details);
            upsert_event(c, a, &occ)?;
            assert_eq!(missing_details(c, a, 10)?, vec!["master".to_string()]);

            let mut master = parse_event(&timed("master", "2026-01-01T22:00:00", "2026-01-01T22:15:00")).unwrap();
            master.event_type = "seriesMaster".into();
            master.subject = "Standup".into();
            upsert_event(c, a, &master)?;
            assert!(missing_details(c, a, 10)?.is_empty());

            let got = list_events(c, "2026-10-27T13:00:00Z", "2026-10-28T13:00:00Z", "2026-10-28", "2026-10-29")?;
            assert_eq!(got.len(), 1, "the master itself is never listed");
            assert_eq!(got[0].remote_id, "occ1");
            assert_eq!(got[0].subject, "Standup");
            assert_eq!(got[0].organizer_address.as_deref(), Some("sam@x.com"));

            // A later bare update (times moved) keeps the details.
            upsert_event(c, a, &parse_event(&bare("occ1", "2026-10-27T23:00:00", "2026-10-27T23:15:00")).unwrap())?;
            let got = event_by_remote(c, a, "occ1")?.unwrap();
            assert_eq!((got.start_at.as_str(), got.subject.as_str()), ("2026-10-27T23:00:00Z", "Standup"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn bare_single_events_are_queued_for_fetching_and_keep_details_once_fetched() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let bare = json!({
                "id": "solo",
                "start": { "dateTime": "2026-10-27T03:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-27T04:00:00.0000000", "timeZone": "UTC" },
            });
            upsert_event(c, a, &parse_event(&bare).unwrap())?;
            assert_eq!(missing_details(c, a, 10)?, vec!["solo".to_string()]);
            upsert_event(c, a, &parse_event(&timed("solo", "2026-10-27T03:00:00", "2026-10-27T04:00:00")).unwrap())?;
            assert!(missing_details(c, a, 10)?.is_empty());
            upsert_event(c, a, &parse_event(&bare).unwrap())?;
            assert_eq!(event_by_remote(c, a, "solo")?.unwrap().subject, "Event solo");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn window_staleness() {
        let (s, e) = fresh_window();
        assert!(!window_is_stale(&s, &e));
        assert!(window_is_stale("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"));
        assert!(window_is_stale("garbage", &e));
    }
}
