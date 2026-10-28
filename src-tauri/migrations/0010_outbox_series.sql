-- Event ops on one series (its master and any occurrence) go out in the order they were
-- made, so the outbox notes which series an op belongs to. NULL for mail ops.
ALTER TABLE outbox ADD COLUMN series_id TEXT;
