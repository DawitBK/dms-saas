-- AUDIT-FINDINGS-2026-07-26.md #10/#11.
--
-- #10: `documents` was missing the tenant-composite indexes `letters` already
-- got after its own past perf issue (20260703000003-letters-indexes.sql).
-- listDocuments (documents.service.ts) always filters tenant_id + deleted_at
-- IS NULL, then optionally department_id / folder_id / owner_id / status,
-- ordered by updated_at DESC. Only one tenant-composite index existed
-- (idx_documents_tenant_deleted_updated, tenant_id+deleted_at+updated_at) —
-- it covers the unfiltered case but not "tenant X's PENDING docs in
-- department Y", which falls back to a single-column index scan on
-- department_id/status/owner_id/folder_id and re-filters everything else.
CREATE INDEX IF NOT EXISTS idx_documents_tenant_dept_deleted_updated
  ON documents(tenant_id, department_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_folder_deleted_updated
  ON documents(tenant_id, folder_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_owner_deleted_updated
  ON documents(tenant_id, owner_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_status_deleted_updated
  ON documents(tenant_id, status, deleted_at, updated_at DESC);

-- #11: 20260610000000-baseline.sql and 20260615000010-perf-indexes.sql,
-- five days apart, each independently created a single-column index on the
-- same four documents columns under different names — every insert/update
-- has been maintaining two redundant B-trees per column since. Drop the
-- newer (perf-indexes) duplicate set; the composite indexes above are now
-- the ones doing the real work for filtered list queries, and the baseline
-- single-column indexes are kept as-is (dropping either set is equivalent —
-- keeping the older migration's names is simply less churn).
DROP INDEX IF EXISTS idx_documents_status;
DROP INDEX IF EXISTS idx_documents_department_id;
DROP INDEX IF EXISTS idx_documents_owner_id;
DROP INDEX IF EXISTS idx_documents_deleted_at;
