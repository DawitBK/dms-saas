CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_department_id ON documents(department_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner_id ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at);

DROP INDEX IF EXISTS idx_documents_tenant_dept_deleted_updated;
DROP INDEX IF EXISTS idx_documents_tenant_folder_deleted_updated;
DROP INDEX IF EXISTS idx_documents_tenant_owner_deleted_updated;
DROP INDEX IF EXISTS idx_documents_tenant_status_deleted_updated;
