-- BUG 1 FIX: Replace full unique constraint with partial unique index on folder_nodes
-- This allows deactivated folders' paths to be immediately reused.

-- CRITICAL: The baseline migration created a UNIQUE CONSTRAINT (not just an index)
-- named folder_nodes_tenant_id_path_key on (tenant_id, path).
-- This was added via a later migration (20260611000003-sprint4-models.sql).
-- We must drop the CONSTRAINT, not just the index.

-- Drop the existing unique constraint
-- PostgreSQL creates both a constraint AND an index with the same name
ALTER TABLE folder_nodes DROP CONSTRAINT IF EXISTS folder_nodes_tenant_id_path_key;

-- Also drop any other indexes that may exist from old migrations
DROP INDEX IF EXISTS folder_nodes_tenant_id_path_idx;

-- Create partial unique index that only enforces uniqueness for active folders
-- This allows multiple inactive folders with the same path, enabling path reuse
CREATE UNIQUE INDEX IF NOT EXISTS folder_nodes_tenant_id_path_active_idx 
  ON folder_nodes (tenant_id, path) 
  WHERE is_active = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- DROP INDEX IF EXISTS folder_nodes_tenant_id_path_active_idx;
-- ALTER TABLE folder_nodes ADD CONSTRAINT folder_nodes_tenant_id_path_key UNIQUE (tenant_id, path);
