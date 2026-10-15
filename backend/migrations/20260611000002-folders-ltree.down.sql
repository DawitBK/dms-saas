-- Reverts 20260611000002-folders-ltree.sql. Drops the ltree path column and
-- both indexes this migration added to folder_nodes; parent_id itself
-- predates this migration (baseline), so only its index is dropped, not the
-- column. Any values materialized into path_ltree are lost on the way down,
-- which is fine since the app code that reads it is also being rolled back.
--
-- The pg_catalog `ltree` extension itself is intentionally left installed:
-- 20260626000001-department-nesting.sql also uses the ltree type, so
-- dropping the extension here would break that later migration's objects.
DROP INDEX IF EXISTS folder_nodes_parent_id_idx;
DROP INDEX IF EXISTS folder_nodes_path_ltree_gist;
ALTER TABLE folder_nodes DROP COLUMN IF EXISTS path_ltree;
