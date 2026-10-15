-- SAFE: purely additive nullable-with-default column, mirrors the existing
-- tenants.ai_features JSONB precedent (20260701000002-phase5-phase6.sql) —
-- generalizes it into a reusable per-tenant feature-flag store (rollout.md
-- §4.2), so risky code paths can ship dark (deployed, flag off) and get
-- turned on per-tenant without a redeploy.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feature_flags JSONB NOT NULL DEFAULT '{}';
