-- Reverts 20260626000001-department-nesting.sql. Drops the triggers, their
-- backing functions, the ltree indexes, and the parent_id/path/level columns
-- that made departments a nested hierarchy. Any parent_id/path/level values
-- computed by the backfill and the triggers are lost, which is expected —
-- the app code being rolled back to never read those columns anyway.
-- The ltree extension itself is intentionally left installed: it's a
-- database-wide object that may be relied on elsewhere, and CREATE EXTENSION
-- IF NOT EXISTS in the up migration was already a no-op if something else
-- had installed it first.
DROP TRIGGER IF EXISTS trigger_departments_parent_id_change ON departments;
DROP TRIGGER IF EXISTS trigger_departments_before_insert ON departments;

DROP FUNCTION IF EXISTS departments_parent_id_change_trigger();
DROP FUNCTION IF EXISTS departments_before_insert_trigger();
DROP FUNCTION IF EXISTS update_department_path(UUID);
DROP FUNCTION IF EXISTS department_ltree_label(UUID);

DROP INDEX IF EXISTS departments_path_gist_idx;
DROP INDEX IF EXISTS departments_parent_id_idx;

ALTER TABLE departments DROP COLUMN IF EXISTS level;
ALTER TABLE departments DROP COLUMN IF EXISTS path;
ALTER TABLE departments DROP COLUMN IF EXISTS parent_id;
