DROP INDEX IF EXISTS "folder_nodes_org_unit_id_idx";
ALTER TABLE "folder_nodes" DROP COLUMN IF EXISTS "org_unit_id";
