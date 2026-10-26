-- Conversations the user opened, for the Recent Opens pane. One row per conversation;
-- reopening moves it to the top. Pruned to the newest 200 on insert.
CREATE TABLE recent_opens (
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  opened_at       TEXT NOT NULL,
  PRIMARY KEY (account_id, conversation_id)
);
CREATE INDEX recent_opens_time ON recent_opens (opened_at DESC);
