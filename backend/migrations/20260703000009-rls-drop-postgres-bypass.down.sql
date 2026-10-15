-- Reverts 20260703000009-rls-drop-postgres-bypass.sql by recreating the same
-- 6 policies with the `OR current_user = 'postgres'` clause restored — i.e.
-- reapplying 20260615000002-rls-policies.sql's original CREATE POLICY
-- statements verbatim, exactly as this file's own down() comment specifies.
--
-- ORDERING NOTE (part of the 7-migration RLS chain — see
-- 20260615000002-rls-policies.down.sql for the full list): this runs BEFORE
-- 20260615000002-rls-policies.sql's own down (which just drops these
-- policies outright), so restoring the old body here is purely to make the
-- intermediate state correct in case `migrate down` is stopped partway
-- through the chain (e.g. `--to` some migration between the two). It has no
-- observable effect once the chain is reverted all the way.
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS workflow_defs_tenant_isolation ON workflow_definitions;
CREATE POLICY workflow_defs_tenant_isolation ON workflow_definitions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS workflow_inst_tenant_isolation ON workflow_instances;
CREATE POLICY workflow_inst_tenant_isolation ON workflow_instances
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS workflow_tasks_tenant_isolation ON workflow_tasks;
CREATE POLICY workflow_tasks_tenant_isolation ON workflow_tasks
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS webhooks_tenant_isolation ON webhook_subscriptions;
CREATE POLICY webhooks_tenant_isolation ON webhook_subscriptions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );

DROP POLICY IF EXISTS dept_keys_tenant_isolation ON dept_keys;
CREATE POLICY dept_keys_tenant_isolation ON dept_keys
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_user = 'postgres'
  );
