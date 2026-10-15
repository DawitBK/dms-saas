-- S6-01: PostgreSQL Row-Level Security for multi-tenant isolation.
-- Requires: tenant context middleware sets app.current_tenant session variable.
-- The app DB user should NOT be a superuser in production (superusers bypass RLS by default).

-- ─── Enable RLS on multi-tenant tables ───────────────────────────────────────

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept_keys ENABLE ROW LEVEL SECURITY;

-- ─── Documents ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

-- ─── Workflow Definitions ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS workflow_defs_tenant_isolation ON workflow_definitions;
CREATE POLICY workflow_defs_tenant_isolation ON workflow_definitions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

-- ─── Workflow Instances ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS workflow_inst_tenant_isolation ON workflow_instances;
CREATE POLICY workflow_inst_tenant_isolation ON workflow_instances
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

-- ─── Workflow Tasks ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS workflow_tasks_tenant_isolation ON workflow_tasks;
CREATE POLICY workflow_tasks_tenant_isolation ON workflow_tasks
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

-- ─── Webhook Subscriptions ────────────────────────────────────────────────────

DROP POLICY IF EXISTS webhooks_tenant_isolation ON webhook_subscriptions;
CREATE POLICY webhooks_tenant_isolation ON webhook_subscriptions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

-- ─── Dept Keys ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS dept_keys_tenant_isolation ON dept_keys;
CREATE POLICY dept_keys_tenant_isolation ON dept_keys
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
-- ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
-- (repeat for all tables)
