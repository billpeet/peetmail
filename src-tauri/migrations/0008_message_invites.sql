-- Gmail invitations carry a text/calendar part; what it said, per message (uid NULL: the
-- message has none). Lets the invite card find the event without refetching the message.
CREATE TABLE message_invites (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  uid        TEXT,
  method     TEXT,
  partstat   TEXT
);
