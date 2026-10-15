-- Reverts 20260702000003-audit-tenant-id.sql. Safe: a nullable column plus
-- two partial/composite indexes on top of it, purely additive — nothing else
-- depends on them existing at the database level. Any tenant_id values
-- stamped onto audit_logs rows since this shipped are lost on rollback,
-- which is expected (the app code being rolled back to never wrote or read
-- this column, and tenant-scoped audit filtering simply goes back to
-- unavailable).
DROP INDEX IF EXISTS audit_logs_tenant_doc_idx;
DROP INDEX IF EXISTS audit_logs_tenant_seq_idx;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS tenant_id;
