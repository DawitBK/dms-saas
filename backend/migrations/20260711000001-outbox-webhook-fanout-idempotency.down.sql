-- Reverts 20260711000001-outbox-webhook-fanout-idempotency.sql. Safe: a
-- nullable self-referencing column plus a partial unique index on top of it,
-- purely additive — nothing else depends on them existing at the database
-- level. Reintroduces the bug this migration fixed (enqueueWebhookFanout's
-- attempts-based `=== 1` heuristic can permanently, silently skip webhook
-- fan-out for an event reclaimed after a crash), which is expected for a
-- rollback — the app code that relies on source_event_id for idempotency is
-- also being rolled back with it.
DROP INDEX IF EXISTS outbox_events_source_event_webhook_key;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS source_event_id;
