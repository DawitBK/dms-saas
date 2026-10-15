DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'departments' AND column_name = 'tenant_id') THEN
        ALTER TABLE "departments" ADD COLUMN "tenant_id" VARCHAR(50) NOT NULL DEFAULT 'default';
    END IF;
END $$;

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'departments' AND constraint_name = 'departments_tenant_id_code_key') THEN
        ALTER TABLE "departments" DROP CONSTRAINT IF EXISTS "departments_code_key";
        ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_code_key" UNIQUE ("tenant_id", "code");
    END IF;
END $$;

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'document_types' AND column_name = 'tenant_id') THEN
        ALTER TABLE "document_types" ADD COLUMN "tenant_id" VARCHAR(50) NOT NULL DEFAULT 'default';
    END IF;
END $$;

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'document_types' AND constraint_name = 'document_types_tenant_id_code_key') THEN
        ALTER TABLE "document_types" DROP CONSTRAINT IF EXISTS "document_types_code_key";
        ALTER TABLE "document_types" ADD CONSTRAINT "document_types_tenant_id_code_key" UNIQUE ("tenant_id", "code");
    END IF;
END $$;

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'folder_nodes' AND column_name = 'tenant_id') THEN
        ALTER TABLE "folder_nodes" ADD COLUMN "tenant_id" VARCHAR(50) NOT NULL DEFAULT 'default';
    END IF;
END $$;

DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'folder_nodes' AND constraint_name = 'folder_nodes_tenant_id_path_key') THEN
        ALTER TABLE "folder_nodes" DROP CONSTRAINT IF EXISTS "folder_nodes_path_key";
        ALTER TABLE "folder_nodes" ADD CONSTRAINT "folder_nodes_tenant_id_path_key" UNIQUE ("tenant_id", "path");
    END IF;
END $$;
