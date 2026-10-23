//! SQLite cache. One connection behind a mutex is enough for Phase 0:
//! every query here is an indexed lookup that takes microseconds.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;

const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;",
        )?;
        migrate(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut conn = self.conn.lock().expect("db mutex poisoned");
        f(&mut conn)
    }
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

// ---------- settings ----------

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ---------- models ----------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub provider: String,
    pub email: String,
    pub display_name: Option<String>,
    /// False when the account has no usable tokens, e.g. after the client ID changed.
    pub signed_in: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub remote_id: String,
    pub role: Option<String>,
    pub name: String,
    pub delta_link: Option<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub message_id: i64,
    pub account_id: i64,
    pub conversation_id: String,
    pub subject: String,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub received_at: String,
    pub preview: String,
    pub message_count: i64,
    pub unread_count: i64,
    pub is_flagged: bool,
    pub has_attachments: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: i64,
    pub subject: String,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub to: serde_json::Value,
    pub cc: serde_json::Value,
    pub received_at: String,
    pub preview: String,
    pub is_read: bool,
    pub has_attachments: bool,
}

/// Fields from one Graph message. `None` means "not in this delta page",
/// so the upsert keeps the cached value.
#[derive(Debug, Default)]
pub struct MessageUpsert {
    pub remote_id: String,
    pub conversation_id: Option<String>,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub to_json: Option<String>,
    pub cc_json: Option<String>,
    pub received_at: Option<String>,
    pub preview: Option<String>,
    pub is_read: Option<bool>,
    pub is_flagged: Option<bool>,
    pub has_attachments: Option<bool>,
    pub importance: Option<String>,
    pub inference: Option<String>,
}

// ---------- accounts ----------

pub fn list_accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id, provider, email, display_name, token_blob IS NOT NULL FROM accounts ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Account {
            id: r.get(0)?,
            provider: r.get(1)?,
            email: r.get(2)?,
            display_name: r.get(3)?,
            signed_in: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn upsert_account(
    conn: &Connection,
    provider: &str,
    email: &str,
    display_name: Option<&str>,
    token_blob: &[u8],
) -> Result<Account> {
    let id: i64 = conn.query_row(
        "INSERT INTO accounts (provider, email, display_name, token_blob) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name, token_blob = excluded.token_blob
         RETURNING id",
        params![provider, email, display_name, token_blob],
        |r| r.get(0),
    )?;
    Ok(Account {
        id,
        provider: provider.into(),
        email: email.into(),
        display_name: display_name.map(Into::into),
        signed_in: true,
    })
}

pub fn get_token_blob(conn: &Connection, account_id: i64) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row("SELECT token_blob FROM accounts WHERE id = ?1", [account_id], |r| r.get(0))
        .optional()?
        .flatten())
}

pub fn set_token_blob(conn: &Connection, account_id: i64, blob: &[u8]) -> Result<()> {
    conn.execute("UPDATE accounts SET token_blob = ?2 WHERE id = ?1", params![account_id, blob])?;
    Ok(())
}

/// Tokens are bound to the client ID that issued them, so changing the ID invalidates all of them.
/// Cached mail is kept and reattached when the same mailbox signs in again.
pub fn clear_all_tokens(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE accounts SET token_blob = NULL", [])?;
    Ok(())
}

pub fn delete_account(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute("DELETE FROM accounts WHERE id = ?1", [account_id])?;
    Ok(())
}

// ---------- folders ----------

const FOLDER_COLS: &str = "id, account_id, remote_id, role, name, delta_link, last_synced_at";

fn folder_from_row(r: &rusqlite::Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        account_id: r.get(1)?,
        remote_id: r.get(2)?,
        role: r.get(3)?,
        name: r.get(4)?,
        delta_link: r.get(5)?,
        last_synced_at: r.get(6)?,
    })
}

pub fn list_folders(conn: &Connection, account_id: i64) -> Result<Vec<Folder>> {
    let mut stmt = conn.prepare(&format!("SELECT {FOLDER_COLS} FROM folders WHERE account_id = ?1 ORDER BY id"))?;
    let rows = stmt.query_map([account_id], folder_from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn folder_by_role(conn: &Connection, account_id: i64, role: &str) -> Result<Option<Folder>> {
    Ok(conn
        .query_row(
            &format!("SELECT {FOLDER_COLS} FROM folders WHERE account_id = ?1 AND role = ?2"),
            params![account_id, role],
            folder_from_row,
        )
        .optional()?)
}

pub fn insert_folder(conn: &Connection, account_id: i64, remote_id: &str, role: &str, name: &str) -> Result<Folder> {
    conn.execute(
        "INSERT INTO folders (account_id, remote_id, role, name) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (account_id, remote_id) DO UPDATE SET role = excluded.role, name = excluded.name",
        params![account_id, remote_id, role, name],
    )?;
    Ok(folder_by_role(conn, account_id, role)?.expect("folder just inserted"))
}

pub fn set_delta_link(conn: &Connection, folder_id: i64, delta_link: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE folders SET delta_link = ?2, last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?1",
        params![folder_id, delta_link],
    )?;
    Ok(())
}

pub fn clear_delta_links(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE folders SET delta_link = NULL", [])?;
    Ok(())
}

// ---------- messages ----------

pub fn upsert_message(conn: &Connection, account_id: i64, folder_id: i64, m: &MessageUpsert) -> Result<()> {
    // A new row needs received_at. A partial update for a message we never cached is skipped.
    conn.execute(
        "INSERT INTO messages (account_id, folder_id, remote_id, conversation_id, subject, from_name, from_address,
                               to_json, cc_json, received_at, preview, is_read, is_flagged, has_attachments,
                               importance, inference)
         SELECT ?1, ?2, ?3, COALESCE(?4, ?3), COALESCE(?5, ''), ?6, ?7, COALESCE(?8, '[]'), COALESCE(?9, '[]'),
                ?10, COALESCE(?11, ''), COALESCE(?12, 0), COALESCE(?13, 0), COALESCE(?14, 0), ?15, ?16
         WHERE ?10 IS NOT NULL
         ON CONFLICT (account_id, remote_id) DO UPDATE SET
           folder_id       = excluded.folder_id,
           conversation_id = COALESCE(?4,  conversation_id),
           subject         = COALESCE(?5,  subject),
           from_name       = COALESCE(?6,  from_name),
           from_address    = COALESCE(?7,  from_address),
           to_json         = COALESCE(?8,  to_json),
           cc_json         = COALESCE(?9,  cc_json),
           received_at     = COALESCE(?10, received_at),
           preview         = COALESCE(?11, preview),
           is_read         = COALESCE(?12, is_read),
           is_flagged      = COALESCE(?13, is_flagged),
           has_attachments = COALESCE(?14, has_attachments),
           importance      = COALESCE(?15, importance),
           inference       = COALESCE(?16, inference)",
        params![
            account_id, folder_id, m.remote_id, m.conversation_id, m.subject, m.from_name, m.from_address,
            m.to_json, m.cc_json, m.received_at, m.preview, m.is_read, m.is_flagged, m.has_attachments,
            m.importance, m.inference
        ],
    )?;
    if m.received_at.is_none() {
        // Partial update (delta often sends only changed props, e.g. isRead).
        conn.execute(
            "UPDATE messages SET
               conversation_id = COALESCE(?3,  conversation_id),
               subject         = COALESCE(?4,  subject),
               from_name       = COALESCE(?5,  from_name),
               from_address    = COALESCE(?6,  from_address),
               to_json         = COALESCE(?7,  to_json),
               cc_json         = COALESCE(?8,  cc_json),
               preview         = COALESCE(?9,  preview),
               is_read         = COALESCE(?10, is_read),
               is_flagged      = COALESCE(?11, is_flagged),
               has_attachments = COALESCE(?12, has_attachments),
               importance      = COALESCE(?13, importance),
               inference       = COALESCE(?14, inference)
             WHERE account_id = ?1 AND remote_id = ?2",
            params![
                account_id, m.remote_id, m.conversation_id, m.subject, m.from_name, m.from_address, m.to_json,
                m.cc_json, m.preview, m.is_read, m.is_flagged, m.has_attachments, m.importance, m.inference
            ],
        )?;
    }
    Ok(())
}

pub fn delete_message(conn: &Connection, account_id: i64, remote_id: &str) -> Result<()> {
    conn.execute("DELETE FROM messages WHERE account_id = ?1 AND remote_id = ?2", params![account_id, remote_id])?;
    Ok(())
}

/// Drops cached messages older than the configured window.
pub fn prune_older_than(conn: &Connection, folder_id: i64, cutoff_iso: &str) -> Result<usize> {
    Ok(conn.execute("DELETE FROM messages WHERE folder_id = ?1 AND received_at < ?2", params![folder_id, cutoff_iso])?)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub received_at: String,
    pub message_id: i64,
}

/// One row per conversation (its newest message), newest first, keyset-paginated.
pub fn list_threads(conn: &Connection, folder_id: i64, cursor: Option<&Cursor>, limit: i64) -> Result<Vec<ThreadRow>> {
    let mut stmt = conn.prepare_cached(
        "WITH ranked AS (
           SELECT m.*,
                  ROW_NUMBER()     OVER w AS rn,
                  COUNT(*)         OVER (PARTITION BY conversation_id) AS cnt,
                  SUM(1 - is_read) OVER (PARTITION BY conversation_id) AS unread
           FROM messages m
           WHERE folder_id = ?1
           WINDOW w AS (PARTITION BY conversation_id ORDER BY received_at DESC, id DESC)
         )
         SELECT id, account_id, conversation_id, subject, from_name, from_address, received_at, preview,
                cnt, unread, is_flagged, has_attachments
         FROM ranked
         WHERE rn = 1 AND (?2 IS NULL OR (received_at, id) < (?2, ?3))
         ORDER BY received_at DESC, id DESC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(
        params![folder_id, cursor.map(|c| &c.received_at), cursor.map(|c| c.message_id), limit],
        |r| {
            Ok(ThreadRow {
                message_id: r.get(0)?,
                account_id: r.get(1)?,
                conversation_id: r.get(2)?,
                subject: r.get(3)?,
                from_name: r.get(4)?,
                from_address: r.get(5)?,
                received_at: r.get(6)?,
                preview: r.get(7)?,
                message_count: r.get(8)?,
                unread_count: r.get(9)?,
                is_flagged: r.get(10)?,
                has_attachments: r.get(11)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_thread(conn: &Connection, account_id: i64, conversation_id: &str) -> Result<Vec<MessageRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, subject, from_name, from_address, to_json, cc_json, received_at, preview, is_read, has_attachments
         FROM messages WHERE account_id = ?1 AND conversation_id = ?2
         ORDER BY received_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![account_id, conversation_id], |r| {
        let to: String = r.get(4)?;
        let cc: String = r.get(5)?;
        Ok(MessageRow {
            id: r.get(0)?,
            subject: r.get(1)?,
            from_name: r.get(2)?,
            from_address: r.get(3)?,
            to: serde_json::from_str(&to).unwrap_or_default(),
            cc: serde_json::from_str(&cc).unwrap_or_default(),
            received_at: r.get(6)?,
            preview: r.get(7)?,
            is_read: r.get(8)?,
            has_attachments: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// (account_id, remote_id) for a cached message.
pub fn message_remote(conn: &Connection, message_id: i64) -> Result<Option<(i64, String)>> {
    Ok(conn
        .query_row("SELECT account_id, remote_id FROM messages WHERE id = ?1", [message_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?)
}

// ---------- body cache ----------

pub fn get_body(conn: &Connection, message_id: i64) -> Result<Option<String>> {
    let html: Option<String> = conn
        .query_row("SELECT html FROM message_bodies WHERE message_id = ?1", [message_id], |r| r.get(0))
        .optional()?;
    if html.is_some() {
        conn.execute(
            "UPDATE message_bodies SET accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE message_id = ?1",
            [message_id],
        )?;
    }
    Ok(html)
}

pub fn put_body(conn: &Connection, message_id: i64, html: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO message_bodies (message_id, html, size, fetched_at, accessed_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (message_id) DO UPDATE SET html = excluded.html, size = excluded.size,
           fetched_at = excluded.fetched_at, accessed_at = excluded.accessed_at",
        params![message_id, html, html.len() as i64],
    )?;
    Ok(())
}

/// Evicts least-recently-read bodies until the cache fits in `max_bytes`.
pub fn evict_bodies(conn: &Connection, max_bytes: i64) -> Result<usize> {
    let total: i64 = conn.query_row("SELECT COALESCE(SUM(size), 0) FROM message_bodies", [], |r| r.get(0))?;
    if total <= max_bytes {
        return Ok(0);
    }
    Ok(conn.execute(
        "DELETE FROM message_bodies WHERE message_id IN (
           SELECT message_id FROM (
             SELECT message_id, size, SUM(size) OVER (ORDER BY accessed_at, message_id) AS running
             FROM message_bodies
           ) WHERE running - size < ?1
         )",
        [total - max_bytes],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> (Db, i64, i64) {
        let db = Db::open_in_memory().unwrap();
        let (a, f) = db
            .with(|c| {
                let a = upsert_account(c, "microsoft", "boris@example.com", Some("Boris"), b"x")?;
                let f = insert_folder(c, a.id, "inbox-remote", "inbox", "Inbox")?;
                Ok((a.id, f.id))
            })
            .unwrap();
        (db, a, f)
    }

    fn msg(id: &str, conv: &str, at: &str, read: bool) -> MessageUpsert {
        MessageUpsert {
            remote_id: id.into(),
            conversation_id: Some(conv.into()),
            subject: Some(format!("subject {id}")),
            received_at: Some(at.into()),
            is_read: Some(read),
            ..Default::default()
        }
    }

    #[test]
    fn threads_group_by_conversation_newest_first() {
        let (db, a, f) = seed();
        db.with(|c| {
            upsert_message(c, a, f, &msg("m1", "c1", "2026-10-01T10:00:00Z", true))?;
            upsert_message(c, a, f, &msg("m2", "c1", "2026-10-03T10:00:00Z", false))?;
            upsert_message(c, a, f, &msg("m3", "c2", "2026-10-02T10:00:00Z", false))?;
            let t = list_threads(c, f, None, 10)?;
            assert_eq!(t.len(), 2);
            assert_eq!(t[0].conversation_id, "c1");
            assert_eq!(t[0].subject, "subject m2");
            assert_eq!(t[0].message_count, 2);
            assert_eq!(t[0].unread_count, 1);
            assert_eq!(t[1].conversation_id, "c2");

            let cur = Cursor { received_at: t[0].received_at.clone(), message_id: t[0].message_id };
            let page2 = list_threads(c, f, Some(&cur), 10)?;
            assert_eq!(page2.len(), 1);
            assert_eq!(page2[0].conversation_id, "c2");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn partial_update_keeps_cached_fields() {
        let (db, a, f) = seed();
        db.with(|c| {
            upsert_message(c, a, f, &msg("m1", "c1", "2026-10-01T10:00:00Z", false))?;
            upsert_message(c, a, f, &MessageUpsert { remote_id: "m1".into(), is_read: Some(true), ..Default::default() })?;
            let t = get_thread(c, a, "c1")?;
            assert_eq!(t.len(), 1);
            assert!(t[0].is_read);
            assert_eq!(t[0].subject, "subject m1");
            // A partial update for an unknown message must not create a row.
            upsert_message(c, a, f, &MessageUpsert { remote_id: "ghost".into(), is_read: Some(true), ..Default::default() })?;
            let n: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
            assert_eq!(n, 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn clearing_tokens_signs_out_but_keeps_mail() {
        let (db, a, f) = seed();
        db.with(|c| {
            upsert_message(c, a, f, &msg("m1", "c1", "2026-10-01T10:00:00Z", false))?;
            clear_all_tokens(c)?;
            let accounts = list_accounts(c)?;
            assert!(!accounts[0].signed_in);
            assert!(get_token_blob(c, a)?.is_none());
            // Signing in again with the same mailbox reuses the row and its cache.
            let again = upsert_account(c, "microsoft", "boris@example.com", None, b"y")?;
            assert_eq!(again.id, a);
            assert!(list_accounts(c)?[0].signed_in);
            assert_eq!(list_threads(c, f, None, 10)?.len(), 1);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn body_eviction_is_lru() {
        let (db, a, f) = seed();
        db.with(|c| {
            for (i, id) in ["m1", "m2", "m3"].iter().enumerate() {
                upsert_message(c, a, f, &msg(id, id, &format!("2026-10-0{}T10:00:00Z", i + 1), true))?;
            }
            for (id, ch) in [(1, "a"), (2, "b"), (3, "c")] {
                put_body(c, id, &ch.repeat(100))?;
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            get_body(c, 1)?; // touch m1, so m2 is now the oldest
            assert_eq!(evict_bodies(c, 200)?, 1);
            assert!(get_body(c, 2)?.is_none());
            assert!(get_body(c, 1)?.is_some());
            assert!(get_body(c, 3)?.is_some());
            Ok(())
        })
        .unwrap();
    }
}
