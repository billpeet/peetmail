-- Meeting messages: meetingRequest | meetingCancelled | meetingAccepted |
-- meetingTenativelyAccepted (sic, Graph's spelling) | meetingDeclined. NULL for ordinary mail.
ALTER TABLE messages ADD COLUMN meeting_message_type TEXT;

-- Messages cached before invites were detected were all stored as plain mail; a fresh
-- delta pass reclassifies them.
UPDATE folders SET delta_link = NULL;
