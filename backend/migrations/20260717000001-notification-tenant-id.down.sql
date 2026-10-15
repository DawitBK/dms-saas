DROP INDEX IF EXISTS notifications_tenant_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS tenant_id;
