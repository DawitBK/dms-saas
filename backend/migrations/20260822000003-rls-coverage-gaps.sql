-- P1-15 item 4: tenant-scoped tables that carried NO row-level security.
--
-- Cross-checking every table with a `tenant_id` column against the tables the
-- *-rls-*.sql migrations actually cover turned up eight gaps. Six are fixed here.
-- Each of these tables holds tenant-owned data and was relying entirely on the
-- application remembering to add `WHERE tenant_id = ?` — which is exactly the
-- assumption RLS exists to stop the platform from having to make.
--
-- TWO GAPS ARE DELIBERATELY LEFT OPEN, and this is the record of why:
--
--   * user_tenants                — read by modules/auth/auth.routes.ts in
--     /auth/login, /auth/refresh and /auth/callback to decide WHICH tenant the
--     caller may select. Those reads happen before tenantContext runs, so
--     app.current_tenant is unset and a tenant policy would match nothing:
--     enabling RLS here makes every login fail with "no access to this tenant".
--     It is also read by infrastructure/queue/outbox.ts's poller, outside any
--     request. Fixing it properly needs a policy that permits the unset-GUC case
--     for this table specifically, which is a behaviour change to the auth path
--     and wants its own tested migration.
--
--   * user_permission_overrides   — read by roles.service.ts's
--     resolveUnionPermissions(), which is called from the same three pre-tenant
--     auth paths. Same failure mode: silent zero rows, so every user loses their
--     permission overrides at login.
--
-- Policy shape is copied verbatim from 20260615000002-rls-policies.sql, including
-- the `OR current_user = 'postgres'` escape. That escape is what makes dev and the
-- test suite work at all (both connect as postgres, see .env) and is also why RLS
-- is currently exercised by exactly zero automated tests on this platform.
--
-- BEFORE APPLYING: these six tables are read under tenantContext in the request
-- path and under withWorkerTenantContext in workers, which is why they are the
-- safe subset. If any code path reads one of them outside both, RLS will return
-- zero rows SILENTLY rather than erroring. The down migration reverses this
-- cleanly, and the boot probe added in infrastructure/database/sequelize.ts
-- (assertRlsIsEnforced) will now refuse to start a production process where RLS
-- is not actually filtering.

ALTER TABLE departments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_nodes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_types     ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_bundles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_comments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_templates     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS departments_tenant_isolation ON departments;
CREATE POLICY departments_tenant_isolation ON departments
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS folder_nodes_tenant_isolation ON folder_nodes;
CREATE POLICY folder_nodes_tenant_isolation ON folder_nodes
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS document_types_tenant_isolation ON document_types;
CREATE POLICY document_types_tenant_isolation ON document_types
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS document_bundles_tenant_isolation ON document_bundles;
CREATE POLICY document_bundles_tenant_isolation ON document_bundles
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS document_comments_tenant_isolation ON document_comments;
CREATE POLICY document_comments_tenant_isolation ON document_comments
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS form_templates_tenant_isolation ON form_templates;
CREATE POLICY form_templates_tenant_isolation ON form_templates
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );
