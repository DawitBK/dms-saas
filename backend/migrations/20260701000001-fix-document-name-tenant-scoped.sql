-- Fix document_name uniqueness to be tenant-scoped.
-- The baseline created `document_name VARCHAR(255) NOT NULL UNIQUE`, which
-- enforces a global uniqueness constraint across all tenants. In a multi-tenant
-- system every tenant should be able to use the same generated name independently.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'documents'
          AND constraint_name = 'documents_tenant_id_document_name_key'
    ) THEN
        -- Drop the global unique constraint (auto-named by PostgreSQL on inline UNIQUE)
        ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_document_name_key";
        -- Add tenant-scoped composite unique constraint
        ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_document_name_key"
            UNIQUE ("tenant_id", "document_name");
    END IF;
END $$;
