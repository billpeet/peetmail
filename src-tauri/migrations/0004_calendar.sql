-- Calendar events (occurrences, as returned by calendarView: recurring series arrive expanded).
-- Timed events store UTC ISO instants; all-day events store local dates (YYYY-MM-DD, end exclusive).
CREATE TABLE events (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  remote_id         TEXT NOT NULL,
  subject           TEXT NOT NULL DEFAULT '',
  start_at          TEXT NOT NULL,
  end_at            TEXT NOT NULL,
  is_all_day        INTEGER NOT NULL DEFAULT 0,
  location          TEXT,
  organizer_name    TEXT,
  organizer_address TEXT,
  attendees_json    TEXT NOT NULL DEFAULT '[]',
  response          TEXT,          -- none | organizer | accepted | tentativelyAccepted | declined | notResponded
  is_organizer      INTEGER NOT NULL DEFAULT 0,
  is_cancelled      INTEGER NOT NULL DEFAULT 0,
  show_as           TEXT,          -- free | tentative | busy | oof | workingElsewhere
  join_url          TEXT,
  web_link          TEXT,
  preview           TEXT NOT NULL DEFAULT '',
  UNIQUE (account_id, remote_id)
);
CREATE INDEX events_time ON events (account_id, start_at);

-- Delta state for the rolling calendarView window, per account.
CREATE TABLE calendar_sync (
  account_id   INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  delta_link   TEXT,
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL
);
