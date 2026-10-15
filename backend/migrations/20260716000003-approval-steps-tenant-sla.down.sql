DROP POLICY IF EXISTS approval_steps_tenant_isolation ON approval_steps;
ALTER TABLE approval_steps DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS approval_steps_sla_sweep_idx;
DROP INDEX IF EXISTS approval_steps_tenant_idx;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS sla_breached_at;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS tenant_id;
