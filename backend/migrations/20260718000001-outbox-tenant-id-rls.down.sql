DROP POLICY IF EXISTS outbox_events_tenant_isolation ON outbox_events;
ALTER TABLE outbox_events DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS outbox_events_tenant_idx;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS tenant_id;
