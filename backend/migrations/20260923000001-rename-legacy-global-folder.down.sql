-- Reverts 20260923000001-rename-legacy-global-folder.sql. Restores the old
-- hardcoded literal name for the same structurally-identified rows (level 1,
-- no org unit, no department, system-managed) -- safe because the up
-- migration only ever touched rows already matching that exact shape.
UPDATE folder_nodes
SET name = 'Example Corp'
WHERE level = 1
  AND org_unit_id IS NULL
  AND department_id IS NULL
  AND is_system_managed = TRUE
  AND name = 'Global Folders';
