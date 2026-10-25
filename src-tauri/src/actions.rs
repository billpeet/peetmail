//! Conversation-level triage (archive, delete, read state, flag) with undo.
//! Each action updates SQLite immediately and queues the matching outbox ops.

use rusqlite::Connection;
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
    Ok(UndoEntry { label: action.label().into(), account_id, before: targets, ops })
}

/// Reverses an action: cancels ops still waiting in the queue and queues inverse ops
/// for any that already reached the server.
pub fn undo(conn: &mut Connection, entry: &UndoEntry) -> Result<()> {
    let tx = conn.transaction()?;
    for m in &entry.before {
        db::restore_state(&tx, m)?;
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
