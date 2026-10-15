DROP INDEX IF EXISTS "document_types_org_unit_id_idx";
ALTER TABLE "document_types" DROP CONSTRAINT IF EXISTS "document_types_not_both_dept_and_org_unit";
ALTER TABLE "document_types" DROP COLUMN IF EXISTS "org_unit_id";
