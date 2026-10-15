-- Reverts 20260615000002-rls-policies.sql, using the exact down() draft
-- already sketched at the bottom of that file.
--
-- ORDERING NOTE (part of a 7-migration RLS chain — see also
-- 20260703000008/009/010, 20260710000001, and 20260717000002/000003's
-- down.sql files): by the time `migrate down` reaches THIS file, later
-- migrations in the chain have already been reverted in reverse-chronological
-- order, most relevantly 20260703000009-rls-drop-postgres-bypass.sql's down,
-- which recreates these same 6 policies with the `OR current_user =
-- 'postgres'` clause restored. So the policies being dropped here are back to
-- the exact form this migration originally created — DROP POLICY IF EXISTS
-- doesn't care about the policy body either way, but this is noted so it's
-- clear the chain is semantically consistent, not coincidentally safe.
DROP POLICY IF EXISTS dept_keys_tenant_isolation ON dept_keys;
DROP POLICY IF EXISTS webhooks_tenant_isolation ON webhook_subscriptions;
DROP POLICY IF EXISTS workflow_tasks_tenant_isolation ON workflow_tasks;
DROP POLICY IF EXISTS workflow_inst_tenant_isolation ON workflow_instances;
DROP POLICY IF EXISTS workflow_defs_tenant_isolation ON workflow_definitions;
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;

ALTER TABLE dept_keys DISABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances DISABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
