DROP POLICY IF EXISTS form_templates_tenant_isolation ON form_templates;
DROP POLICY IF EXISTS document_comments_tenant_isolation ON document_comments;
DROP POLICY IF EXISTS document_bundles_tenant_isolation ON document_bundles;
DROP POLICY IF EXISTS document_types_tenant_isolation ON document_types;
DROP POLICY IF EXISTS folder_nodes_tenant_isolation ON folder_nodes;
DROP POLICY IF EXISTS departments_tenant_isolation ON departments;

ALTER TABLE form_templates     DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_comments  DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_bundles   DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_types     DISABLE ROW LEVEL SECURITY;
ALTER TABLE folder_nodes       DISABLE ROW LEVEL SECURITY;
ALTER TABLE departments        DISABLE ROW LEVEL SECURITY;
