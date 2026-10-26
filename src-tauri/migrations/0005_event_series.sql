-- calendarView delta sends occurrences of recurring series as bare items (id, start, end,
-- seriesMasterId); subject, location, attendees etc. live on the series master. Masters
-- are stored as rows too (event_type = 'seriesMaster', never listed), and event_view
-- fills each occurrence's details from its master.
ALTER TABLE events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'singleInstance';
ALTER TABLE events ADD COLUMN series_master_id TEXT;
-- 1 when the row carries its own details (subject, organiser...), 0 for bare items.
ALTER TABLE events ADD COLUMN has_details INTEGER NOT NULL DEFAULT 1;

-- Rows synced before this migration may be bare items stored as if complete; refetch.
UPDATE events SET has_details = 0 WHERE organizer_address IS NULL AND response IS NULL AND web_link IS NULL;
UPDATE calendar_sync SET delta_link = NULL;

CREATE VIEW event_view AS
SELECT
  e.id, e.account_id, e.remote_id,
  CASE WHEN e.has_details = 1 THEN e.subject ELSE COALESCE(m.subject, e.subject) END AS subject,
  e.start_at, e.end_at, e.is_all_day,
  CASE WHEN e.has_details = 1 THEN e.location ELSE m.location END AS location,
  CASE WHEN e.has_details = 1 THEN e.organizer_name ELSE m.organizer_name END AS organizer_name,
  CASE WHEN e.has_details = 1 THEN e.organizer_address ELSE m.organizer_address END AS organizer_address,
  CASE WHEN e.has_details = 1 THEN e.attendees_json ELSE COALESCE(m.attendees_json, '[]') END AS attendees_json,
  CASE WHEN e.has_details = 1 THEN e.response ELSE m.response END AS response,
  CASE WHEN e.has_details = 1 THEN e.is_organizer ELSE COALESCE(m.is_organizer, 0) END AS is_organizer,
  e.is_cancelled,
  CASE WHEN e.has_details = 1 THEN e.show_as ELSE m.show_as END AS show_as,
  CASE WHEN e.has_details = 1 THEN e.join_url ELSE m.join_url END AS join_url,
  CASE WHEN e.has_details = 1 THEN e.web_link ELSE m.web_link END AS web_link,
  CASE WHEN e.has_details = 1 THEN e.preview ELSE COALESCE(m.preview, '') END AS preview,
  e.event_type, e.series_master_id, e.has_details
FROM events e
LEFT JOIN events m ON m.account_id = e.account_id AND m.remote_id = e.series_master_id
WHERE e.event_type <> 'seriesMaster';
