-- Snooze: a conversation leaves the inbox until a time, then comes back on top.

-- Lists sort by sort_at, which is received_at except for a conversation that has just
-- come back from a snooze (its newest message gets the wake time, so it sorts first).
ALTER TABLE messages ADD COLUMN sort_at TEXT NOT NULL DEFAULT '';
UPDATE messages SET sort_at = received_at;
DROP INDEX IF EXISTS messages_folder_received;
CREATE INDEX messages_folder_sort ON messages (folder_id, sort_at DESC, id DESC);

CREATE TABLE snoozes (
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  until           TEXT NOT NULL,           -- UTC, '%Y-%m-%dT%H:%M:%fZ' (compared as text)
  PRIMARY KEY (account_id, conversation_id)
);
CREATE INDEX snoozes_until ON snoozes (until);
