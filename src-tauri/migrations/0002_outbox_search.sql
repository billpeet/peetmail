-- Pending remote mutations. Applied locally first; a worker replays them to Graph.
CREATE TABLE outbox (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id   TEXT,                      -- message the op targets (NULL for new mail)
  op          TEXT NOT NULL,             -- JSON, see outbox.rs `Op`
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  not_before  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX outbox_due ON outbox (status, not_before, id);
CREATE INDEX outbox_remote ON outbox (account_id, remote_id);

-- 'message' or 'eventMessage' (meeting invites and responses).
ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'message';

-- Full-text index. rowid = messages.id. `body` is filled in when a body is fetched
-- and survives body-cache eviction, so searched mail stays searchable.
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  subject, sender, recipients, preview, body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, sender, recipients, preview, body)
  VALUES (new.id, new.subject, COALESCE(new.from_name, '') || ' ' || COALESCE(new.from_address, ''),
          new.to_json || ' ' || new.cc_json, new.preview, '');
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, from_name, from_address, to_json, cc_json, preview ON messages BEGIN
  UPDATE messages_fts SET
    subject = new.subject,
    sender = COALESCE(new.from_name, '') || ' ' || COALESCE(new.from_address, ''),
    recipients = new.to_json || ' ' || new.cc_json,
    preview = new.preview
  WHERE rowid = new.id;
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;

INSERT INTO messages_fts (rowid, subject, sender, recipients, preview, body)
SELECT id, subject, COALESCE(from_name, '') || ' ' || COALESCE(from_address, ''), to_json || ' ' || cc_json, preview, ''
FROM messages;
