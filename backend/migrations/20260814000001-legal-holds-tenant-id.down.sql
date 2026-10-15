DROP INDEX IF EXISTS legal_holds_tenant_idx;
ALTER TABLE legal_holds DROP COLUMN IF EXISTS tenant_id;
