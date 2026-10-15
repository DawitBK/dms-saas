-- S4-01: Add ltree path column and GiST index to folder_nodes
-- Requires pg_catalog.ltree extension

CREATE EXTENSION IF NOT EXISTS ltree;

ALTER TABLE folder_nodes
  ADD COLUMN IF NOT EXISTS path_ltree ltree;

CREATE INDEX IF NOT EXISTS folder_nodes_path_ltree_gist
  ON folder_nodes USING GIST (path_ltree);

CREATE INDEX IF NOT EXISTS folder_nodes_parent_id_idx
  ON folder_nodes (parent_id);
