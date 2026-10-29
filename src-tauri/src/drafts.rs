//! Drafts: what's in the composer, saved as it's typed. Closing the composer keeps the
//! message here (the Drafts view reopens it), and so does a crash; sending or discarding
//! removes it. Each draft is kept in step with the account's own drafts (draft_sync.rs):
//! local edits are pushed, the server's are pulled, and the last save wins.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::draft_files::{self, DraftFile};
use crate::error::Result;
use crate::outbox::DraftKind;

/// The composer's state, as the composer holds it (addresses as typed).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DraftDoc {
    pub kind: DraftKind,
    pub reference_message_id: Option<i64>,
    pub conversation_id: Option<String>,
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
    pub html: String,
    pub attachments: Vec<DraftFile>,
    pub dropped_attachments: Vec<String>,
    /// Started in Outlook or Gmail: sent through the server's copy, which keeps its
    /// threading (PeetMail doesn't know which message it answers).
    pub imported: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedDraft {
    pub id: i64,
    pub account_id: i64,
    /// When it was last saved (UTC).
    pub updated_at: String,
    pub draft: DraftDoc,
}

/// Threading of a Gmail draft started elsewhere, needed to push it back unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RemoteMeta {
    pub thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

/// A draft with its sync state.
#[derive(Debug, Clone, PartialEq)]
pub struct DraftRow {
    pub id: i64,
    pub account_id: i64,
    pub seq: i64,
    pub remote_id: Option<String>,
    pub remote_version: Option<String>,
    pub dirty: bool,
    pub hidden: bool,
    pub meta: RemoteMeta,
    pub doc: DraftDoc,
}

const NEXT_SEQ: &str = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM drafts)";

/// Saves a local edit: updates `id` if it's still there, else adds a new draft. Marks it
/// as changed here, so the next push sends it. Returns its id.
pub fn save(conn: &Connection, id: Option<i64>, account_id: i64, doc: &DraftDoc) -> Result<i64> {
    let data = serde_json::to_string(doc)?;
    if let Some(id) = id {
        let updated = conn.execute(
            &format!(
                "UPDATE drafts SET account_id = ?2, data = ?3, dirty = 1, hidden = 0, seq = {NEXT_SEQ},
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1"
            ),
            params![id, account_id, data],
        )?;
        if updated == 1 {
            return Ok(id);
        }
    }
    Ok(conn.query_row(
        &format!("INSERT INTO drafts (account_id, data, seq, dirty) VALUES (?1, ?2, {NEXT_SEQ}, 1) RETURNING id"),
        params![account_id, data],
        |r| r.get(0),
    )?)
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<(DraftRow, String)> {
    let meta: Option<String> = r.get(7)?;
    Ok((
        DraftRow {
            id: r.get(0)?,
            account_id: r.get(1)?,
            seq: r.get(2)?,
            remote_id: r.get(3)?,
            remote_version: r.get(4)?,
            dirty: r.get(5)?,
            hidden: r.get(6)?,
            meta: meta.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or_default(),
            doc: DraftDoc::default(),
        },
        r.get(8)?,
    ))
}

const ROW_COLS: &str = "id, account_id, seq, remote_id, remote_version, dirty, hidden, remote_meta, data";

fn parse((mut row, data): (DraftRow, String)) -> Option<DraftRow> {
    match serde_json::from_str(&data) {
        Ok(doc) => {
            row.doc = doc;
            Some(row)
        }
        Err(e) => {
            log::warn!("draft {} can't be read: {e}", row.id);
            None
        }
    }
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<DraftRow>> {
    let row = conn.query_row(&format!("SELECT {ROW_COLS} FROM drafts WHERE id = ?1"), [id], row_from).optional()?;
    Ok(row.and_then(parse))
}

/// Every draft of an account that has a server copy.
pub fn with_remote(conn: &Connection, account_id: i64) -> Result<Vec<DraftRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {ROW_COLS} FROM drafts WHERE account_id = ?1 AND remote_id IS NOT NULL"))?;
    let rows = stmt.query_map([account_id], row_from)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().filter_map(parse).collect())
}

/// Drafts to list, most recently edited first (not ones being sent).
pub fn list(conn: &Connection) -> Result<Vec<SavedDraft>> {
    let mut stmt = conn.prepare("SELECT id, account_id, updated_at, data FROM drafts WHERE hidden = 0 ORDER BY seq DESC")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, account_id, updated_at, data) = row?;
        match serde_json::from_str(&data) {
            Ok(draft) => out.push(SavedDraft { id, account_id, updated_at, draft }),
            Err(e) => log::warn!("draft {id} can't be read: {e}"),
        }
    }
    Ok(out)
}

/// Removes a draft. `keep_files`: its attachments now belong to something else (a send).
/// Returns its account and server id, if it had a server copy (to delete there too).
pub fn delete(conn: &Connection, id: i64, keep_files: bool) -> Result<Option<(i64, String)>> {
    let row: Option<(i64, Option<String>, String)> = conn
        .query_row("DELETE FROM drafts WHERE id = ?1 RETURNING account_id, remote_id, data", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    let Some((account_id, remote_id, data)) = row else { return Ok(None) };
    if !keep_files {
        let doc: DraftDoc = serde_json::from_str(&data).unwrap_or_default();
        draft_files::remove(conn, &doc.attachments.iter().map(|f| f.id).collect::<Vec<_>>())?;
    }
    Ok(remote_id.map(|r| (account_id, r)))
}

/// A push landed: the server's copy is `remote_id` at `version`. Still changed here if it
/// was edited again while the push was on its way (`seq` moved on).
pub fn mark_pushed(conn: &Connection, id: i64, seq: i64, remote_id: &str, version: &str) -> Result<()> {
    conn.execute(
        "UPDATE drafts SET remote_id = ?3, remote_version = ?4, dirty = CASE WHEN seq = ?2 THEN 0 ELSE dirty END WHERE id = ?1",
        params![id, seq, remote_id, version],
    )?;
    Ok(())
}

/// Drafts changed here that haven't reached the server, as (account, id): left by a push
/// that failed for good, or saved before drafts synced. Pushed again at startup.
pub fn unpushed(conn: &Connection) -> Result<Vec<(i64, i64)>> {
    let mut stmt = conn.prepare("SELECT account_id, id FROM drafts WHERE dirty = 1 AND hidden = 0")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Out of the list while it's being sent, or back in it.
pub fn set_hidden(conn: &Connection, id: i64, hidden: bool) -> Result<()> {
    conn.execute("UPDATE drafts SET hidden = ?2 WHERE id = ?1", params![id, hidden])?;
    Ok(())
}

/// The server's version of a draft, pulled: replaces what's here (which wasn't changed
/// since the last push, or the caller wouldn't pull it). New drafts are added. Returns the id.
pub fn apply_remote(conn: &Connection, account_id: i64, remote_id: &str, version: &str, meta: &RemoteMeta, doc: &DraftDoc) -> Result<i64> {
    let data = serde_json::to_string(doc)?;
    let meta = serde_json::to_string(meta)?;
    let existing: Option<(i64, String)> = conn
        .query_row("SELECT id, data FROM drafts WHERE account_id = ?1 AND remote_id = ?2", params![account_id, remote_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match existing {
        Some((id, old)) => {
            // Files the new version no longer has go.
            let old: DraftDoc = serde_json::from_str(&old).unwrap_or_default();
            let gone: Vec<i64> = old.attachments.iter().filter(|f| !doc.attachments.iter().any(|n| n.id == f.id)).map(|f| f.id).collect();
            draft_files::remove(conn, &gone)?;
            conn.execute(
                &format!(
                    "UPDATE drafts SET data = ?2, remote_version = ?3, remote_meta = ?4, dirty = 0, seq = {NEXT_SEQ},
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1"
                ),
                params![id, data, version, meta],
            )?;
            Ok(id)
        }
        None => Ok(conn.query_row(
            &format!(
                "INSERT INTO drafts (account_id, data, seq, remote_id, remote_version, remote_meta, dirty)
                 VALUES (?1, ?2, {NEXT_SEQ}, ?3, ?4, ?5, 0) RETURNING id"
            ),
            params![account_id, data, remote_id, version, meta],
            |r| r.get(0),
        )?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Db};

    fn doc(subject: &str) -> DraftDoc {
        DraftDoc { to: "priya@fabrikam.io".into(), subject: subject.into(), body: "Hi".into(), ..Default::default() }
    }

    #[test]
    fn drafts_are_saved_updated_and_listed_newest_first() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let first = save(c, None, a, &doc("one"))?;
            let second = save(c, None, a, &doc("two"))?;
            assert_eq!(save(c, Some(first), a, &doc("one, edited"))?, first, "an update keeps its id");
            let list = list(c)?;
            assert_eq!(list.iter().map(|d| (d.id, d.draft.subject.as_str())).collect::<Vec<_>>(), vec![(first, "one, edited"), (second, "two")]);
            // Saving a draft that was deleted meanwhile starts a new one, never reusing the id.
            delete(c, second, false)?;
            let again = save(c, Some(second), a, &doc("two"))?;
            assert_ne!(again, second);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn discarding_frees_the_files_and_sending_keeps_them() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let f1 = draft_files::add(c, "a.txt", "text/plain", b"a")?;
            let f2 = draft_files::add(c, "b.txt", "text/plain", b"b")?;
            let discarded = save(c, None, a, &DraftDoc { attachments: vec![f1.clone()], ..doc("x") })?;
            let sent = save(c, None, a, &DraftDoc { attachments: vec![f2.clone()], ..doc("y") })?;
            // A saved draft's files survive the startup clean-up.
            assert_eq!(draft_files::purge_orphans(c)?, 0);
            delete(c, discarded, false)?;
            delete(c, sent, true)?;
            assert!(draft_files::data(c, f1.id)?.is_none());
            assert!(draft_files::data(c, f2.id)?.is_some());
            assert!(list(c)?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn drafts_go_with_their_account() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            save(c, None, a, &doc("x"))?;
            db::delete_account(c, a)?;
            assert!(list(c)?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_push_clears_the_change_unless_it_was_edited_again_meanwhile() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let id = save(c, None, a, &doc("x"))?;
            let pushing = get(c, id)?.unwrap();
            assert!(pushing.dirty);
            mark_pushed(c, id, pushing.seq, "R1", "v1")?;
            let pushed = get(c, id)?.unwrap();
            assert_eq!((pushed.remote_id.as_deref(), pushed.remote_version.as_deref(), pushed.dirty), (Some("R1"), Some("v1"), false));

            let pushing = get(c, id)?.unwrap();
            save(c, Some(id), a, &doc("x, typed while pushing"))?;
            mark_pushed(c, id, pushing.seq, "R1", "v2")?;
            assert!(get(c, id)?.unwrap().dirty, "the newer edit still has to go up");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn pulled_versions_replace_the_draft_and_its_files() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            let a = db::upsert_account(c, "microsoft", "b@x.com", None, b"t")?.id;
            let old = draft_files::add(c, "old.txt", "text/plain", b"o")?;
            let new = draft_files::add(c, "new.txt", "text/plain", b"n")?;
            let meta = RemoteMeta::default();
            let id = apply_remote(c, a, "R1", "v1", &meta, &DraftDoc { attachments: vec![old.clone()], imported: true, ..doc("from Outlook") })?;
            let row = get(c, id)?.unwrap();
            assert!(!row.dirty && row.doc.imported);
            assert_eq!(apply_remote(c, a, "R1", "v2", &meta, &DraftDoc { attachments: vec![new.clone()], imported: true, ..doc("edited in Outlook") })?, id);
            let row = get(c, id)?.unwrap();
            assert_eq!((row.doc.subject.as_str(), row.remote_version.as_deref()), ("edited in Outlook", Some("v2")));
            assert!(draft_files::data(c, old.id)?.is_none(), "the replaced file goes");
            assert_eq!(with_remote(c, a)?.len(), 1);
            // Being sent: hidden from the list, back when the send is taken back.
            set_hidden(c, id, true)?;
            assert!(list(c)?.is_empty());
            set_hidden(c, id, false)?;
            assert_eq!(list(c)?.len(), 1);
            assert_eq!(delete(c, id, false)?, Some((a, "R1".to_string())));
            Ok(())
        })
        .unwrap();
    }
}
