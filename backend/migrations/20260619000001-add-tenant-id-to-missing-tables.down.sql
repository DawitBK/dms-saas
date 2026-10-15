-- Reverts 20260619000001-add-tenant-id-to-missing-tables.sql, in reverse
-- order of the tables touched (folder_nodes, document_types, departments).
-- For each table this restores the original single-column UNIQUE constraint
-- (the exact baseline-assigned name, e.g. departments_code_key) that the up
-- migration replaced with a (tenant_id, code)/(tenant_id, path) constraint,
-- then drops the tenant_id column itself. Any per-tenant duplicate
-- codes/paths that only became possible once tenant_id existed cannot be
-- restored safely — if such duplicates exist, the ADD CONSTRAINT below will
-- fail, which is the correct outcome (better than silently corrupting data).
-- This assumes 20260624000002-folder-partial-unique-index.sql's down has
-- already run first (rollback order), so folder_nodes_tenant_id_path_key
-- exists again to be dropped here.

-- folder_nodes
ALTER TABLE "folder_nodes" DROP CONSTRAINT IF EXISTS "folder_nodes_tenant_id_path_key";
ALTER TABLE "folder_nodes" ADD CONSTRAINT "folder_nodes_path_key" UNIQUE ("path");
ALTER TABLE "folder_nodes" DROP COLUMN IF EXISTS "tenant_id";

-- document_types
ALTER TABLE "document_types" DROP CONSTRAINT IF EXISTS "document_types_tenant_id_code_key";
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_code_key" UNIQUE ("code");
ALTER TABLE "document_types" DROP COLUMN IF EXISTS "tenant_id";

-- departments
ALTER TABLE "departments" DROP CONSTRAINT IF EXISTS "departments_tenant_id_code_key";
ALTER TABLE "departments" ADD CONSTRAINT "departments_code_key" UNIQUE ("code");
ALTER TABLE "departments" DROP COLUMN IF EXISTS "tenant_id";
