-- Files attached in the composer. The bytes wait here (not as paths, which can move or
-- change before a scheduled send) until the message has gone out.
CREATE TABLE draft_files (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
