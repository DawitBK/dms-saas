-- getOrCreateOrganisationFolder (folders.service.ts, commit bb1457a) renamed
-- the tenant-wide, org-unit-less "umbrella" folder from a hardcoded
-- "Example Corp" to "Global Folders" -- that name collided with a real
-- tenant's own name, so it read as if the tenant itself were one more org
-- unit sitting alongside its real ones (HQ, branches). That commit only
-- changed the code path that creates a NEW folder; any tenant that already
-- had one kept the stale name forever, which is exactly what surfaced live:
-- "Example Corp" shown in Browse, absent from Organization/new-department
-- pickers (which list real org_units, and this folder was never one --
-- org_unit_id IS NULL is what marks it as the global umbrella, not a
-- deactivated or missing org unit).
--
-- Scoped by structural shape (level 1, no org unit, no department, system-
-- managed), not by name, so it can never touch a real org-unit folder or a
-- user-created folder that happens to share the old literal name.
UPDATE folder_nodes
SET name = 'Global Folders'
WHERE level = 1
  AND org_unit_id IS NULL
  AND department_id IS NULL
  AND is_system_managed = TRUE
  AND name <> 'Global Folders';
