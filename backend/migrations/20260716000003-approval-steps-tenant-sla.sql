-- H7: approval_steps was the only new engine table with no tenant_id and no
-- RLS — tenant isolation rested entirely on the app remembering to join through
-- approval_chains. Add tenant_id (backfilled from the parent chain), enable RLS,
-- and index it.
--
-- H6: add sla_breached_at so the new engine-step SLA sweeper can flag an overdue
-- step exactly once (mirrors workflow_tasks.sla_breached_at).
--
-- SAFE: the SET NOT NULL below runs in the same migration that adds AND
-- backfills the column from the parent chain (with a defensive orphan delete
-- first), and the engine code that writes approval_steps already stamps
-- tenant_id on every insert — no deployed code path writes a NULL.

ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100);
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ NULL;

-- Backfill tenant_id from the owning chain.
UPDATE approval_steps s
   SET tenant_id = c.tenant_id
  FROM approval_chains c
 WHERE s.chain_id = c.id
   AND s.tenant_id IS NULL;

-- Any orphan steps (should not exist due to FK) cannot be tenant-scoped; leaving
-- them NULL would break the NOT NULL below, so delete them defensively.
DELETE FROM approval_steps WHERE tenant_id IS NULL;

ALTER TABLE approval_steps ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS approval_steps_tenant_idx ON approval_steps (tenant_id);
-- Sweep support: overdue PENDING steps not yet flagged.
CREATE INDEX IF NOT EXISTS approval_steps_sla_sweep_idx
  ON approval_steps (due_at)
  WHERE status = 'PENDING' AND sla_breached_at IS NULL;

-- ── RLS (same pattern as approval_chains) ────────────────────────────────────
ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_steps_tenant_isolation ON approval_steps;
CREATE POLICY approval_steps_tenant_isolation ON approval_steps
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''));
