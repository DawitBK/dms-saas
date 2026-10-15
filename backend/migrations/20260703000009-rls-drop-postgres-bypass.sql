-- S6-06 (Phase 6 "RLS done right"): remove the `OR current_user = 'postgres'`
-- escape hatch from the 6 policies created in 20260615000002-rls-policies.sql.
--
-- That clause was redundant AND misleading: a Postgres superuser bypasses
-- RLS unconditionally at the server level before policies are even
-- evaluated, so the clause never did anything real — it just made the
-- policy source look like `postgres` was an intentionally-modeled exception,
-- when actually the exemption existed regardless of what the policy said.
-- Dropping it does not change behavior for the current `postgres`-as-DB_USER
-- environment (still fully bypassed — see 20260703000008-rls-app-role.sql
-- for the verified proof and the deployment requirement to switch to a
-- non-superuser role like `edams_app` before RLS is actually enforced
-- anywhere). It matters once that switch happens: without this migration,
-- a future non-superuser role would ALSO need to literally be named
-- 'postgres' to slip through the old predicate, which was never the intent.

-- ─── Documents ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─── Workflow Definitions ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS workflow_defs_tenant_isolation ON workflow_definitions;
CREATE POLICY workflow_defs_tenant_isolation ON workflow_definitions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─── Workflow Instances ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS workflow_inst_tenant_isolation ON workflow_instances;
CREATE POLICY workflow_inst_tenant_isolation ON workflow_instances
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─── Workflow Tasks ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS workflow_tasks_tenant_isolation ON workflow_tasks;
CREATE POLICY workflow_tasks_tenant_isolation ON workflow_tasks
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─── Webhook Subscriptions ────────────────────────────────────────────────────

DROP POLICY IF EXISTS webhooks_tenant_isolation ON webhook_subscriptions;
CREATE POLICY webhooks_tenant_isolation ON webhook_subscriptions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─── Dept Keys ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS dept_keys_tenant_isolation ON dept_keys;
CREATE POLICY dept_keys_tenant_isolation ON dept_keys
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- Recreate each policy with `OR current_user = 'postgres'` restored, i.e.
-- reapply 20260615000002-rls-policies.sql's CREATE POLICY statements verbatim.
