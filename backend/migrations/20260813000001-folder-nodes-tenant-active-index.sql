-- Perf audit 2026-08-13: listReadableFolders (folders.service.ts) and every
-- other folder-tree read filter on `tenant_id + is_active`, ordered by
-- level/name, but folder_nodes only had `parent_id` and a partial unique
-- index on `(tenant_id, path) WHERE is_active` — neither covers this query
-- shape, so it fell back to a full per-tenant sequential scan on every
-- folder browse/tree request.
CREATE INDEX IF NOT EXISTS idx_folder_nodes_tenant_active_level_name
  ON folder_nodes(tenant_id, is_active, level, name)
  WHERE is_active = true;
