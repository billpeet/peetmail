//! Conversation-level triage (archive, delete, read state, flag) with undo.
//! Each action updates SQLite immediately and queues the matching outbox ops.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::{self, MessageState};
use crate::error::Result;
use crate::outbox::{self, Op, GRACE};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Archive,
    Trash,
    MarkRead,
    MarkUnread,
    Flag,
    Unflag,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Action::Archive => "Archived",
            Action::Trash => "Deleted",
            Action::MarkRead => "Marked as read",
            Action::MarkUnread => "Marked as unread",
            Action::Flag => "Flagged",
            Action::Unflag => "Unflagged",
        }
    }
}

/// What it takes to reverse one applied action.
#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub label: String,
    pub account_id: i64,
    /// Local state of each touched message before the action.
    pub before: Vec<MessageState>,
    /// (outbox id, target remote id, op that reverses it on the server)
    pub ops: Vec<(i64, String, Op)>,
    /// A snooze this action set: (conversation id, the snooze it replaced, if any).
    pub snooze: Option<(String, Option<String>)>,
}

/// Outbox destination for snoozed mail; resolved to the hidden server folder when sent.
pub const SNOOZE_DEST: &str = "peetmail:snoozed";
pub const SNOOZED_ROLE: &str = "snoozed";

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Snoozes a conversation until `until`: its inbox messages move to the Snoozed folder
/// now and come back (unread, on top) when it's due. Snoozing an already snoozed
/// conversation just changes the time.
pub fn snooze(conn: &mut Connection, account_id: i64, conversation_id: &str, until: chrono::DateTime<chrono::Utc>) -> Result<UndoEntry> {
    let tx = conn.transaction()?;
    let inbox = db::folder_by_role(&tx, account_id, "inbox")?.map(|f| f.id);
    let snoozed = db::ensure_local_folder(&tx, account_id, SNOOZED_ROLE, "Snoozed")?.id;
    let all = db::conversation_states(&tx, account_id, conversation_id, None)?;
    let targets: Vec<MessageState> = all.iter().filter(|m| Some(m.folder_id) == inbox).cloned().collect();
    let previous: Option<String> = tx
        .query_row("SELECT until FROM snoozes WHERE account_id = ?1 AND conversation_id = ?2", params![account_id, conversation_id], |r| r.get(0))
        .optional()?;
    if targets.is_empty() && previous.is_none() {
        return Ok(UndoEntry { label: "Snoozed".into(), account_id, before: vec![], ops: vec![], snooze: None });
    }
    let mut ops = Vec::with_capacity(targets.len());
    for m in &targets {
        db::set_folder(&tx, m.id, snoozed)?;
        let id = outbox::enqueue(&tx, account_id, Some(&m.remote_id), &Op::Move { destination: SNOOZE_DEST.into() }, GRACE)?;
        ops.push((id, m.remote_id.clone(), Op::Move { destination: "inbox".into() }));
    }
    tx.execute(
        "INSERT INTO snoozes (account_id, conversation_id, until) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id, conversation_id) DO UPDATE SET until = excluded.until",
        params![account_id, conversation_id, until.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()],
    )?;
    tx.commit()?;
    // `before` holds the moved messages; a re-time with nothing moved still needs an entry
    // so undo can restore the old time, so count it as one change.
    Ok(UndoEntry { label: "Snoozed".into(), account_id, before: targets, ops, snooze: Some((conversation_id.into(), previous)) })
}

/// Brings snoozed conversations back to the inbox: those due (`only` None) or one now.
/// Returns the (account, conversation) pairs that came back.
pub fn wake(conn: &mut Connection, only: Option<(i64, &str)>) -> Result<Vec<(i64, String)>> {
    let now = now_iso();
    let tx = conn.transaction()?;
    let due: Vec<(i64, String)> = {
        let mut stmt = tx.prepare(
            "SELECT account_id, conversation_id FROM snoozes
             WHERE (?1 IS NULL AND until <= ?3) OR (account_id = ?1 AND conversation_id = ?2)",
        )?;
        let rows = stmt.query_map(params![only.map(|o| o.0), only.map(|o| o.1), now], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut accounts = Vec::new();
    for (account_id, conversation_id) in due {
        tx.execute("DELETE FROM snoozes WHERE account_id = ?1 AND conversation_id = ?2", params![account_id, conversation_id])?;
        let (Some(inbox), Some(snoozed)) = (db::folder_by_role(&tx, account_id, "inbox")?, db::folder_by_role(&tx, account_id, SNOOZED_ROLE)?) else {
            continue;
        };
        // Only what's still in Snoozed: anything moved or deleted meanwhile stays put.
        let msgs = db::conversation_states(&tx, account_id, &conversation_id, Some(snoozed.id))?;
        for m in &msgs {
            db::set_folder(&tx, m.id, inbox.id)?;
            outbox::enqueue(&tx, account_id, Some(&m.remote_id), &Op::Move { destination: "inbox".into() }, std::time::Duration::ZERO)?;
        }
        if let Some(newest) = msgs.last() {
            db::surface(&tx, newest.id, &now)?;
            if newest.is_read {
                db::set_read(&tx, newest.id, false)?;
                outbox::enqueue(&tx, account_id, Some(&newest.remote_id), &Op::SetRead { value: false }, std::time::Duration::ZERO)?;
            }
            accounts.push((account_id, conversation_id.clone()));
        }
    }
    tx.commit()?;
    Ok(accounts)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnoozedThread {
    #[serde(flatten)]
    pub thread: db::ThreadRow,
    /// When it comes back (UTC).
    pub until: String,
}

/// Snoozed conversations, soonest back first.
pub fn list_snoozed(conn: &Connection) -> Result<Vec<SnoozedThread>> {
    let mut out = Vec::new();
    let snoozes: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare("SELECT account_id, conversation_id, until FROM snoozes ORDER BY until")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut threads: std::collections::HashMap<(i64, String), db::ThreadRow> = Default::default();
    let mut accounts: Vec<i64> = snoozes.iter().map(|s| s.0).collect();
    accounts.dedup();
    for a in accounts {
        if let Some(f) = db::folder_by_role(conn, a, SNOOZED_ROLE)? {
            for t in db::list_threads(conn, db::Scope::Folder(f.id), &crate::query::compile(""), None, 10_000)? {
                threads.insert((t.account_id, t.conversation_id.clone()), t);
            }
        }
    }
    for (a, conv, until) in snoozes {
        if let Some(thread) = threads.remove(&(a, conv)) {
            out.push(SnoozedThread { thread, until });
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutcome {
    /// Toast text, e.g. "Archived". `None` when nothing needed changing.
    pub label: Option<String>,
    pub changed: usize,
}

/// Applies `action` to a conversation inside one transaction. Returns the undo entry
/// (empty `before` means there was nothing to do).
pub fn apply(conn: &mut Connection, account_id: i64, conversation_id: &str, action: Action) -> Result<UndoEntry> {
    let tx = conn.transaction()?;
    let inbox = db::folder_by_role(&tx, account_id, "inbox")?.map(|f| f.id);
    let all = db::conversation_states(&tx, account_id, conversation_id, None)?;

    // Which messages the action touches, and what it does to each.
    let (targets, local, remote, inverse): (Vec<MessageState>, Box<dyn Fn(&Connection, &MessageState) -> Result<()>>, Op, Op) =
        match action {
            Action::Archive | Action::Trash => {
                let (role, name, dest) = if action == Action::Archive {
                    ("archive", "Archive", "archive")
                } else {
                    ("deleteditems", "Deleted Items", "deleteditems")
                };
                let target = db::ensure_local_folder(&tx, account_id, role, name)?.id;
                let in_inbox = all.iter().filter(|m| Some(m.folder_id) == inbox).cloned().collect();
                (
                    in_inbox,
                    Box::new(move |c, m| db::set_folder(c, m.id, target)),
                    Op::Move { destination: dest.into() },
                    Op::Move { destination: "inbox".into() },
                )
            }
            Action::MarkRead => (
                all.iter().filter(|m| !m.is_read).cloned().collect(),
                Box::new(|c, m| db::set_read(c, m.id, true)),
                Op::SetRead { value: true },
                Op::SetRead { value: false },
            ),
            // Like Superhuman: only the newest message goes back to unread.
            Action::MarkUnread => (
                all.iter().rev().find(|m| m.is_read).cloned().into_iter().collect(),
                Box::new(|c, m| db::set_read(c, m.id, false)),
                Op::SetRead { value: false },
                Op::SetRead { value: true },
            ),
            Action::Flag => (
                all.last().filter(|m| !m.is_flagged).cloned().into_iter().collect(),
                Box::new(|c, m| db::set_flagged(c, m.id, true)),
                Op::SetFlag { value: true },
                Op::SetFlag { value: false },
            ),
            Action::Unflag => (
                all.iter().filter(|m| m.is_flagged).cloned().collect(),
                Box::new(|c, m| db::set_flagged(c, m.id, false)),
                Op::SetFlag { value: false },
                Op::SetFlag { value: true },
            ),
        };

    let mut ops = Vec::with_capacity(targets.len());
    for m in &targets {
        local(&tx, m)?;
        let id = outbox::enqueue(&tx, account_id, Some(&m.remote_id), &remote, GRACE)?;
        ops.push((id, m.remote_id.clone(), inverse.clone()));
    }
    drop(local);
    tx.commit()?;
    Ok(UndoEntry { label: action.label().into(), account_id, before: targets, ops, snooze: None })
}

/// Reverses an action: cancels ops still waiting in the queue and queues inverse ops
/// for any that already reached the server.
pub fn undo(conn: &mut Connection, entry: &UndoEntry) -> Result<()> {
    let tx = conn.transaction()?;
    for m in &entry.before {
        db::restore_state(&tx, m)?;
    }
    if let Some((conversation_id, previous)) = &entry.snooze {
        match previous {
            Some(until) => tx.execute(
                "UPDATE snoozes SET until = ?3 WHERE account_id = ?1 AND conversation_id = ?2",
                params![entry.account_id, conversation_id, until],
            )?,
            None => tx.execute("DELETE FROM snoozes WHERE account_id = ?1 AND conversation_id = ?2", params![entry.account_id, conversation_id])?,
        };
    }
    for (outbox_id, remote_id, inverse) in &entry.ops {
        if !outbox::cancel(&tx, *outbox_id)? {
            outbox::enqueue(&tx, entry.account_id, Some(remote_id), inverse, std::time::Duration::ZERO)?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, MessageUpsert};

    fn seed() -> (Db, i64, i64) {
        let db = Db::open_in_memory().unwrap();
        let ids = db
            .with(|c| {
                let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?;
                let inbox = db::insert_folder(c, a.id, "INBOX", "inbox", "Inbox")?;
                for (i, read) in [(1, true), (2, false), (3, false)] {
                    db::upsert_message(c, a.id, inbox.id, &MessageUpsert {
                        remote_id: format!("m{i}"),
                        conversation_id: Some("c1".into()),
                        received_at: Some(format!("2026-10-0{i}T10:00:00Z")),
                        is_read: Some(read),
                        ..Default::default()
                    })?;
                }
                Ok((a.id, inbox.id))
            })
            .unwrap();
        (db, ids.0, ids.1)
    }

    fn queued(c: &Connection) -> Vec<(String, String)> {
        let mut s = c.prepare("SELECT remote_id, op FROM outbox ORDER BY id").unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn archive_moves_locally_queues_moves_and_undo_cancels_them() {
        let (db, a, inbox) = seed();
        db.with(|c| {
            let entry = apply(c, a, "c1", Action::Archive)?;
            assert_eq!(entry.before.len(), 3);
            assert!(db::list_threads(c, db::Scope::Folder(inbox), &crate::query::compile(""), None, 10)?.is_empty());
            assert_eq!(queued(c).len(), 3);
            assert!(queued(c)[0].1.contains("archive"));

            undo(c, &entry)?;
            assert_eq!(db::list_threads(c, db::Scope::Folder(inbox), &crate::query::compile(""), None, 10)?.len(), 1);
            assert!(queued(c).is_empty(), "pending moves are cancelled, nothing sent");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn snooze_moves_out_wakes_on_top_unread_and_undo_restores() {
        let (db, a, inbox) = seed();
        let list = |c: &Connection| db::list_threads(c, db::Scope::Folder(inbox), &crate::query::compile(""), None, 10).unwrap();
        db.with(|c| {
            // A newer conversation, so c1 isn't on top by date.
            db::upsert_message(c, a, inbox, &MessageUpsert {
                remote_id: "n1".into(), conversation_id: Some("c2".into()), received_at: Some("2026-10-20T10:00:00Z".into()), is_read: Some(true), ..Default::default()
            })?;
            apply(c, a, "c1", Action::MarkRead)?;
            c.execute("DELETE FROM outbox", [])?;

            let entry = snooze(c, a, "c1", chrono::Utc::now() + chrono::Duration::hours(3))?;
            assert_eq!(list(c).iter().map(|t| t.conversation_id.as_str()).collect::<Vec<_>>(), vec!["c2"]);
            assert_eq!(queued(c).len(), 3);
            assert!(queued(c)[0].1.contains(SNOOZE_DEST));
            assert_eq!(list_snoozed(c)?.len(), 1);
            assert!(wake(c, None)?.is_empty(), "not due yet");

            undo(c, &entry)?;
            assert_eq!(list(c).len(), 2);
            assert!(list_snoozed(c)?.is_empty());
            assert!(queued(c).is_empty());

            // Due: back in the inbox, on top despite its older date, newest message unread.
            snooze(c, a, "c1", chrono::Utc::now() + chrono::Duration::hours(3))?;
            c.execute("UPDATE snoozes SET until = '2000-01-01T00:00:00.000Z'", [])?;
            c.execute("DELETE FROM outbox", [])?;
            assert_eq!(wake(c, None)?, vec![(a, "c1".to_string())]);
            let threads = list(c);
            assert_eq!(threads[0].conversation_id, "c1");
            assert!(threads[0].reminder);
            assert_eq!(threads[0].unread_count, 1);
            assert!(!threads[1].reminder);
            let q = queued(c);
            assert_eq!(q.iter().filter(|(_, op)| op.contains(r#""destination":"inbox""#)).count(), 3);
            assert!(q.iter().any(|(rid, op)| rid == "m3" && op.contains(r#""value":false"#)));
            assert!(list_snoozed(c)?.is_empty());

            // A resync of the message keeps it on top.
            db::upsert_message(c, a, inbox, &MessageUpsert {
                remote_id: "m3".into(), conversation_id: Some("c1".into()), received_at: Some("2026-10-03T10:00:00Z".into()), ..Default::default()
            })?;
            assert_eq!(list(c)[0].conversation_id, "c1");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn undo_after_send_queues_the_inverse() {
        let (db, a, _) = seed();
        db.with(|c| {
            let entry = apply(c, a, "c1", Action::MarkRead)?;
            assert_eq!(entry.before.len(), 2, "only unread messages are touched");
            // Simulate the worker having already taken both ops.
            c.execute("UPDATE outbox SET status = 'inflight'", [])?;
            undo(c, &entry)?;
            let q = queued(c);
            assert_eq!(q.len(), 4);
            assert!(q[2].1.contains(r#""value":false"#));
            let unread: i64 = c.query_row("SELECT COUNT(*) FROM messages WHERE is_read = 0", [], |r| r.get(0))?;
            assert_eq!(unread, 2);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn mark_unread_touches_only_the_newest_read_message() {
        let (db, a, _) = seed();
        db.with(|c| {
            apply(c, a, "c1", Action::MarkRead)?;
            let entry = apply(c, a, "c1", Action::MarkUnread)?;
            assert_eq!(entry.before.iter().map(|m| m.remote_id.as_str()).collect::<Vec<_>>(), vec!["m3"]);
            Ok(())
        })
        .unwrap();
    }
}
