-- Reverts 20260701000001-fix-document-name-tenant-scoped.sql: swaps the
-- tenant-scoped UNIQUE(tenant_id, document_name) constraint back for the
-- original global UNIQUE(document_name) constraint.
--
-- WARNING: this is not guaranteed to succeed. The whole point of the up
-- migration was to let different tenants share the same document_name,
-- which the global constraint being restored here forbids. If any rows
-- across two or more tenants now share a document_name, re-adding
-- documents_document_name_key will fail with a uniqueness violation, and
-- there is no generically safe way to auto-resolve that collision (renaming
-- rows would corrupt user-facing document names). If this fails, the
-- environment cannot be rolled back past this migration without manually
-- reconciling document_name collisions across tenants first.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'documents'
          AND constraint_name = 'documents_tenant_id_document_name_key'
    ) THEN
        ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_tenant_id_document_name_key";
        ALTER TABLE "documents" ADD CONSTRAINT "documents_document_name_key"
            UNIQUE ("document_name");
    END IF;
END $$;
