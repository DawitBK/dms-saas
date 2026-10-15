-- Reverts 20260611000003-sprint4-models.sql, in reverse order of creation.
-- All five tables were brand-new in this migration, so each is a clean drop
-- (CASCADE is used because later migrations add columns/constraints on top
-- of these tables — e.g. document_deks gets a version_id column and
-- purge_pending gets staged_by_id — and those are dropped along with the
-- table when rolling back this far). Any rows in these tables (DEKs, purge
-- staging, retention tracking, doc locks) are lost, which is expected since
-- the app code that reads/writes them is also being rolled back.

-- S4-12: Document checkout/lock table
DROP INDEX IF EXISTS doc_locks_expires_idx;
DROP TABLE IF EXISTS doc_locks CASCADE;

-- S4-11: Sensitivity labels column on documents
ALTER TABLE documents DROP COLUMN IF EXISTS "sensitivityLabel";

-- S4-03: Retention policy application tracking
DROP INDEX IF EXISTS retention_app_policy_idx;
DROP INDEX IF EXISTS retention_app_eligible_idx;
DROP INDEX IF EXISTS retention_app_document_idx;
DROP TABLE IF EXISTS retention_applications CASCADE;

-- S4-08: Purge pending (soft delete workflow)
DROP INDEX IF EXISTS purge_pending_purge_after_idx;
DROP INDEX IF EXISTS purge_pending_status_idx;
DROP TABLE IF EXISTS purge_pending CASCADE;

-- S4-03: Department key-encryption keys (KEK) tracking
DROP INDEX IF EXISTS dept_keys_tenant_idx;
DROP TABLE IF EXISTS dept_keys CASCADE;

-- S4-03: Document data encryption keys (DEK)
DROP TABLE IF EXISTS document_deks CASCADE;
