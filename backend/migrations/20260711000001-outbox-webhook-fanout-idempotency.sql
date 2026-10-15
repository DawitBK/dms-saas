-- FIX: enqueueWebhookFanout() in outbox.ts was gated in processEvent() by
-- `event.attempts === 1`. `attempts` is incremented at CLAIM time (the
-- atomic UPDATE in processOutbox, before processEvent ever runs) — so if the
-- process crashes/restarts between claiming a row (attempts becomes 1) and
-- reaching the fan-out call, the row is later reclaimed by the existing
-- stale-PROCESSING logic with attempts now 2+, and the `=== 1` check then
-- PERMANENTLY (silently) skips webhook fan-out for that event, forever.
--
-- Replace the attempts-based heuristic with a real idempotency guard instead
-- of trying to police it via a counter that was never meant to track "did
-- fan-out happen": source_event_id records which source outbox row spawned
-- a given WEBHOOK row, and a partial unique index (scoped to channel =
-- 'WEBHOOK') guarantees the database itself will never hold two fan-out rows
-- for the same source event, no matter how many times enqueueWebhookFanout
-- runs for it (retries, reclaims, or even a genuine concurrent double-call).
ALTER TABLE outbox_events
  ADD COLUMN source_event_id UUID REFERENCES outbox_events(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX outbox_events_source_event_webhook_key
  ON outbox_events (source_event_id)
  WHERE channel = 'WEBHOOK' AND source_event_id IS NOT NULL;
