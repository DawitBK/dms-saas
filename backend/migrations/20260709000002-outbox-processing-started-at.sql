-- FIX: the stale-PROCESSING reclaim window was anchored to `process_after`
-- (roughly the row's original due time), not to when a worker actually
-- started processing it. A legitimately slow dispatch (a webhook fan-out or
-- SMTP send taking a bit over 5 minutes) got reclaimed and dispatched a
-- second time, concurrently with itself, while burning a retry attempt each
-- time it was reclaimed — a healthy-but-slow event could exhaust all 3
-- attempts and land in DEAD_LETTER purely for being slow.
ALTER TABLE outbox_events ADD COLUMN processing_started_at TIMESTAMPTZ;
