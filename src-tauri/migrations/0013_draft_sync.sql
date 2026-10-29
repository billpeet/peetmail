-- Drafts kept in step with the account's own (Outlook's Drafts folder, Gmail's drafts).
-- The server's copy: its id (Graph message id, Gmail draft id) and version (Graph
-- lastModifiedDateTime, Gmail message id) as of the last push or pull.
ALTER TABLE drafts ADD COLUMN remote_id TEXT;
ALTER TABLE drafts ADD COLUMN remote_version TEXT;
-- Edited here since the last push: the server's copy is older (last save wins). Drafts
-- saved before this have never been pushed.
ALTER TABLE drafts ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
-- Being sent (undo window, scheduled): out of the Drafts list, back if the send is taken
-- back or fails.
ALTER TABLE drafts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
-- Gmail drafts started elsewhere: their thread and threading headers (JSON).
ALTER TABLE drafts ADD COLUMN remote_meta TEXT;
CREATE UNIQUE INDEX drafts_remote ON drafts (account_id, remote_id);
