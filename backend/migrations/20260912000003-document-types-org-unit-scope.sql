-- DocumentType scoping was binary: department_id NULL meant "global to the
-- whole tenant", non-NULL meant "this one department only". There was no
-- middle tier, so an admin who wanted a type available to every department
-- under a single org unit (without opening it to every other org unit in
-- the tenant) had no way to express that short of creating one duplicate
-- department-scoped row per department -- and the Create Document Type
-- admin form's Scope picker only ever offered "Global (all departments)".
--
-- This adds the missing org_unit_id column, the same tri-level scope
-- (Department < OrgUnit < Tenant) folder_nodes already got in migration
-- 20260912000002-folder-nodes-org-unit.sql. Precedence, enforced by the CHECK
-- below and by documentTypes.service.ts's application logic:
--   department_id set                       -> DEPARTMENT scope (most specific)
--   department_id NULL, org_unit_id set      -> ORG_UNIT scope
--   both NULL                                -> TENANT scope (global, unchanged default)
-- A row is never both department- and org-unit-scoped at once: a
-- department-scoped type's org unit is already reachable via
-- department.org_unit_id, so storing org_unit_id too would just be a second,
-- independently-editable copy of the same fact that could drift from it.
ALTER TABLE "document_types"
  ADD COLUMN IF NOT EXISTS "org_unit_id" UUID NULL REFERENCES "org_units"("id");

ALTER TABLE "document_types"
  ADD CONSTRAINT "document_types_not_both_dept_and_org_unit"
  CHECK (NOT ("department_id" IS NOT NULL AND "org_unit_id" IS NOT NULL));

CREATE INDEX IF NOT EXISTS "document_types_org_unit_id_idx"
  ON "document_types" ("org_unit_id");
