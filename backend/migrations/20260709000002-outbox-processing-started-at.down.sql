-- Reverts 20260709000002-outbox-processing-started-at.sql. Safe: a single
-- nullable column, purely additive — nothing else depends on it existing at
-- the database level. Any in-flight processing timestamps are lost on
-- rollback, which is expected (the app code being rolled back goes back to
-- anchoring the stale-PROCESSING reclaim window on process_after instead,
-- exactly as it did before this column existed — including the double-
-- dispatch-of-a-slow-event bug this migration fixed).
ALTER TABLE outbox_events DROP COLUMN IF EXISTS processing_started_at;
