-- Messages being written, saved as they're typed so closing the composer (or a crash)
-- loses nothing. `data` is the composer's state as JSON (drafts.rs).
CREATE TABLE drafts (
    -- AUTOINCREMENT: a late save for a discarded draft must never land on a newer one.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Bumped on every save: orders drafts by last edit even within one clock tick.
    seq INTEGER NOT NULL DEFAULT 0
);
