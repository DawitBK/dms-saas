-- Tier-3 close-out: outbox_events was deliberately skipped by the RLS series
-- (20260710000001, see its bottom note) because it had NO tenant_id column —
-- tenant was only knowable by parsing the JSON payload. Add the column,
-- backfill it, and give the table a policy that keeps the GUC-less background
-- poller working (it legitimately claims rows across every tenant).
--
-- Like the rest of the series this is inert under the superuser dev role and
-- becomes live when DB_USER switches to edams_app.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NULL;

-- Backfill 1: most producers stamp tenantId into the JSON payload (made
-- universal for the RLS-relevant types in Session 22).
UPDATE outbox_events
   SET tenant_id = payload::jsonb ->> 'tenantId'
 WHERE tenant_id IS NULL
   AND payload::jsonb ->> 'tenantId' IS NOT NULL;

-- Backfill 2: derive from the related document for the remainder.
UPDATE outbox_events o
   SET tenant_id = d.tenant_id
  FROM documents d
 WHERE o.document_id = d.id
   AND o.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS outbox_events_tenant_idx ON outbox_events (tenant_id);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;

-- Policy shape:
--  * GUC unset/empty  -> full visibility. The outbox poller and the workers'
--    claim queries run with no tenant context BY DESIGN (they drain every
--    tenant's rows in one pass). Uses the NULLIF empty-string idiom — after a
--    SET LOCAL + COMMIT a pooled connection reads '' back, not NULL
--    (see 20260717000003).
--  * GUC set          -> only that tenant's rows plus tenant-less platform
--    rows (dead-letter sentinels etc.), so request-context reads/writes are
--    properly fenced.
DROP POLICY IF EXISTS outbox_events_tenant_isolation ON outbox_events;
CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  USING (
    NULLIF(current_setting('app.current_tenant', true), '') IS NULL
    OR tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_tenant', true), '') IS NULL
    OR tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant', true)
  );
