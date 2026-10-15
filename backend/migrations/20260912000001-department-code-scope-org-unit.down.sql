-- Revert to the original tenant-wide uniqueness. Only safe if no tenant has
-- accumulated the same code under two different org units in the meantime --
-- check first:
--   SELECT tenant_id, code, COUNT(*) FROM departments GROUP BY tenant_id, code HAVING COUNT(*) > 1;
DROP INDEX IF EXISTS "departments_tenant_id_org_unit_id_code_key";
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_code_key" UNIQUE ("tenant_id", "code");
