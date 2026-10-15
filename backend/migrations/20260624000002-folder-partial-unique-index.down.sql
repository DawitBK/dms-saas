-- Reverts 20260624000002-folder-partial-unique-index.sql: drops the partial
-- unique index (active folders only) and restores the full
-- folder_nodes_tenant_id_path_key UNIQUE(tenant_id, path) constraint that the
-- up migration replaced it with. If any inactive/deactivated folders now
-- share a (tenant_id, path) with another folder — which the partial index
-- allowed while this migration was applied — re-adding the full constraint
-- will fail; that is the correct outcome, since silently picking which row
-- to keep would be a guess.
--
-- Note: the up migration also unconditionally dropped a
-- folder_nodes_tenant_id_path_idx index described only as "may exist from
-- old migrations" — that index isn't defined by any tracked migration in
-- this history, so there is no known definition to recreate here.
DROP INDEX IF EXISTS folder_nodes_tenant_id_path_active_idx;
ALTER TABLE folder_nodes ADD CONSTRAINT folder_nodes_tenant_id_path_key UNIQUE (tenant_id, path);
