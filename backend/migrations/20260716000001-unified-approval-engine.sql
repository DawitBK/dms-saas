-- Unified approval engine + audit stage + per-type governance policies
-- (SYSTEM-DECISIONS.md D1–D8; SYSTEM-RECOMMENDATIONS.md §1, §3).
--
-- Documents and forms gain the letters-style approval experience through a
-- generalized engine: admin-defined chain templates per type (with locked
-- mandatory steps), author completion at submit, named-person steps, three
-- decisions (APPROVE / REQUEST_CHANGES / DECLINE). Letters keep their own
-- proven implementation for now (they already match the target UX).

-- ── Per-type governance policies (D2, D5, D8) ────────────────────────────────
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS audit_policy VARCHAR(10) NOT NULL DEFAULT 'never';
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS signing_policy VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS reapproval_policy VARCHAR(20) NOT NULL DEFAULT 'none';

-- ── Chain templates (D1) ─────────────────────────────────────────────────────
-- steps JSONB: [{ "stepOrder": 1, "stepType": "REVIEW"|"APPROVE",
--                 "assignedRole": "DEPT_MANAGER" | null, "assignedUserId": null,
--                 "locked": false, "slaHours": 48 }]
CREATE TABLE IF NOT EXISTS approval_chain_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  document_type_id UUID NULL REFERENCES document_types(id) ON DELETE CASCADE,
  form_template_id UUID NULL REFERENCES form_templates(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(document_type_id, form_template_id) <= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_doctype_active_uniq
  ON approval_chain_templates (tenant_id, document_type_id)
  WHERE is_active AND document_type_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_formtpl_active_uniq
  ON approval_chain_templates (tenant_id, form_template_id)
  WHERE is_active AND form_template_id IS NOT NULL;

-- ── Chains (one per submission) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_chains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  item_type VARCHAR(20) NOT NULL, -- 'DOCUMENT' | 'FORM_TEMPLATE' | 'FORM_INSTANCE'
  item_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'IN_REVIEW', -- IN_REVIEW | CHANGES_REQUESTED | APPROVED | DECLINED | CANCELLED
  submitted_by UUID NOT NULL REFERENCES users(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_chains_item_idx ON approval_chains (item_type, item_id);
-- At most one live chain per item.
CREATE UNIQUE INDEX IF NOT EXISTS approval_chains_live_uniq
  ON approval_chains (item_type, item_id)
  WHERE status IN ('IN_REVIEW', 'CHANGES_REQUESTED');

-- ── Steps (generalized letter_approval_steps) ────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id UUID NOT NULL REFERENCES approval_chains(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  step_type VARCHAR(10) NOT NULL, -- REVIEW | APPROVE
  assigned_user_id UUID NULL REFERENCES users(id),
  assigned_role VARCHAR(100) NULL,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  sla_hours INT NULL,
  due_at TIMESTAMPTZ NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'WAITING', -- WAITING | PENDING | APPROVED | CHANGES_REQUESTED | DECLINED | CANCELLED
  comment TEXT,
  decided_by UUID NULL REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- exactly one of named user / role (mirrors letter_approval_steps)
  CHECK ((assigned_user_id IS NULL) <> (assigned_role IS NULL))
);
CREATE INDEX IF NOT EXISTS approval_steps_chain_idx ON approval_steps (chain_id);
CREATE INDEX IF NOT EXISTS approval_steps_pending_user_idx ON approval_steps (assigned_user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS approval_steps_pending_role_idx ON approval_steps (assigned_role) WHERE status = 'PENDING';

-- ── Audit stage (D5–D7) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_stage_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  item_type VARCHAR(20) NOT NULL DEFAULT 'DOCUMENT',
  item_id UUID NOT NULL,
  auditor_user_id UUID NOT NULL REFERENCES users(id), -- D6: final approver picks a named auditor
  assigned_by UUID NOT NULL REFERENCES users(id),     -- the final approver
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING',      -- PENDING | PASSED | FLAGGED
  findings TEXT,                                      -- mandatory on FLAG
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_stage_pending_auditor_idx ON audit_stage_reviews (auditor_user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS audit_stage_item_idx ON audit_stage_reviews (item_type, item_id);

-- ── Signature images (D8c) ───────────────────────────────────────────────────
-- Stored as a data URL (image/png;base64,…) — small, per-user, rendered into
-- letter signatory blocks and ceremony records.
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_image TEXT;

-- ── Form instance approval setting (rec §7.2) ────────────────────────────────
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS instance_approval VARCHAR(10) NOT NULL DEFAULT 'none'; -- none | chain

-- ── Executive notices configurable (D10) ─────────────────────────────────────
-- exec_notice_config: { "letterTypes": ["OUT","MEMO","CIRC","CONT"],
--                       "maxConfidentiality": "INTERNAL" }
-- Empty object = defaults (all letter types, PUBLIC+INTERNAL only — never
-- CONFIDENTIAL/RESTRICTED, per D10).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS exec_notice_config JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS exec_notice_opt_out BOOLEAN NOT NULL DEFAULT FALSE;

-- ── RLS (same pattern as 20260703000009) ─────────────────────────────────────
ALTER TABLE approval_chain_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_tpl_tenant_isolation ON approval_chain_templates;
CREATE POLICY approval_tpl_tenant_isolation ON approval_chain_templates
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''));

ALTER TABLE approval_chains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_chains_tenant_isolation ON approval_chains;
CREATE POLICY approval_chains_tenant_isolation ON approval_chains
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''));

ALTER TABLE audit_stage_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_stage_tenant_isolation ON audit_stage_reviews;
CREATE POLICY audit_stage_tenant_isolation ON audit_stage_reviews
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = nullif(current_setting('app.current_tenant', true), ''));
