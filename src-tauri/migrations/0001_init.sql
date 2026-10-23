CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,              -- 'microsoft' (later: 'google')
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  token_blob   BLOB,                       -- DPAPI-encrypted JSON TokenSet
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE folders (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id      TEXT NOT NULL,
  role           TEXT,                     -- inbox, sentitems, drafts, archive, deleteditems, junkemail
  name           TEXT NOT NULL,
  delta_link     TEXT,
  last_synced_at TEXT,
  UNIQUE (account_id, remote_id)
);

-- Metadata only. Bodies live in message_bodies so list scans stay small
-- and the body cache can be evicted independently.
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  remote_id       TEXT NOT NULL,           -- Graph immutable id
  conversation_id TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  from_name       TEXT,
  from_address    TEXT,
  to_json         TEXT NOT NULL DEFAULT '[]',
  cc_json         TEXT NOT NULL DEFAULT '[]',
  received_at     TEXT NOT NULL,           -- ISO-8601 UTC, sorts lexically
  preview         TEXT NOT NULL DEFAULT '',
  is_read         INTEGER NOT NULL DEFAULT 0,
  is_flagged      INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  importance      TEXT,
  inference       TEXT,                    -- focused / other
  UNIQUE (account_id, remote_id)
);
CREATE INDEX messages_folder_received ON messages (folder_id, received_at DESC, id DESC);
CREATE INDEX messages_conversation    ON messages (account_id, conversation_id);

CREATE TABLE message_bodies (
  message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  html        TEXT NOT NULL,               -- already sanitized
  size        INTEGER NOT NULL,
  fetched_at  TEXT NOT NULL,
  accessed_at TEXT NOT NULL
);
CREATE INDEX message_bodies_lru ON message_bodies (accessed_at);
