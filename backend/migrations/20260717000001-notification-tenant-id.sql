-- S19 audit finding: the notifications table had no tenant_id column, so the
-- cross-tenant admin fan-out rows (dead-letter / virus / HSM alerts that used
-- to be delivered to every tenant's SYSTEM_ADMINs) could not even be filtered
-- or segregated by tenant after the fact, and a multi-tenant user's list mixed
-- tenants. Add a nullable tenant_id, backfill what we can from the related
-- document/letter, and index it. Kept NULLABLE (not RLS-enforced): a user sees
-- their OWN notifications regardless of which tenant they are currently viewing,
-- and some platform-level rows have no single owning tenant. The column exists
-- so callers can stamp and consumers can scope; strict isolation stays at the
-- userId level where notifications are already filtered.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) NULL;

-- Backfill from the related document where present.
UPDATE notifications n
   SET tenant_id = d.tenant_id
  FROM documents d
 WHERE n.document_id = d.id
   AND n.tenant_id IS NULL;

-- Then from the related letter for the remainder.
UPDATE notifications n
   SET tenant_id = l.tenant_id
  FROM letters l
 WHERE n.letter_id = l.id
   AND n.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS notifications_tenant_idx ON notifications (tenant_id);
