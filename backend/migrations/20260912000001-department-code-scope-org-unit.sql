-- Department codes were uniqued tenant-wide (departments_tenant_id_code_key,
-- added 20260619000001) from before org_unit_id existed on this table
-- (20260704000002-department-org-unit.sql added the column afterwards but
-- never revisited the constraint's scope). That leaves every org unit
-- (branch/outlet/sister-company) fighting over one flat code namespace, so a
-- tenant with a "Example Corp" HQ department coded IT can never have a
-- second, independent IT department under a newly created branch org unit --
-- the exact case that surfaced as an unhandled 500 (POST /departments hit the
-- DB unique-constraint violation with nothing catching it) when creating a
-- department under a freshly created org unit whose code collided with an
-- existing department in a different org unit.
--
-- CAMS reference numbers already encode both the UNIT and DEPT segments
-- (REF/UNIT/DEPT/TYPE/YEAR/SEQ -- see DMS/CLAUDE.md), so a code only needs to
-- be unique within its own org unit for the reference number to stay
-- unambiguous. Widening (not dropping) the constraint to
-- (tenant_id, org_unit_id, code) keeps codes globally unique within one org
-- unit while letting each org unit reuse the same short codes (IT, HR, FIN...)
-- independently, matching how department creation is actually used branch by
-- branch.
--
-- Going from a stricter constraint (tenant_id, code) to a looser one
-- (tenant_id, org_unit_id, code) can never introduce a uniqueness conflict in
-- existing data, so this is a safe straight swap with no backfill/dedup step.
ALTER TABLE "departments" DROP CONSTRAINT IF EXISTS "departments_tenant_id_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "departments_tenant_id_org_unit_id_code_key"
  ON "departments" ("tenant_id", "org_unit_id", "code");
