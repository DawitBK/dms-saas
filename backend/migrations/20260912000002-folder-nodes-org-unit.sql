-- Every department folder was parented directly under one single tenant-wide
-- "Example Corp" folder (folders.service.ts's getOrCreateOrganisationFolder),
-- with no regard for which OrgUnit the department actually belongs to. The
-- documented hierarchy is Tenant -> OrgUnit -> Department -> FolderNode (see
-- DMS/CLAUDE.md), but folder_nodes had no way to record an org unit at all, so
-- every department across every org unit landed as a flat, same-level sibling
-- under that one folder -- indistinguishable duplicates when two org units
-- happen to have similarly-named departments (e.g. two "Finance" departments,
-- one per org unit).
--
-- This adds the missing org_unit_id column so a folder can be scoped to a
-- specific org unit the same way it's already scoped to a department
-- (department_id). Nullable: the tenant root and any genuinely global,
-- department-less folder have no org unit. Existing rows are backfilled by
-- backend/scripts/backfill-folder-org-units.ts, which also reparents existing
-- department folders off the single shared org folder onto new, per-org-unit
-- folders -- that reparenting involves recomputing path/level for whole
-- subtrees and is much safer expressed in TypeScript against the same
-- application logic (getOrCreateOrgUnitFolder) than as raw SQL here.
ALTER TABLE "folder_nodes"
  ADD COLUMN IF NOT EXISTS "org_unit_id" UUID NULL REFERENCES "org_units"("id");

CREATE INDEX IF NOT EXISTS "folder_nodes_org_unit_id_idx"
  ON "folder_nodes" ("org_unit_id");
