-- Preserve SSO-selected DMS departments for users who have not signed in yet.
-- The row is consumed by the OIDC callback when the DMS user is provisioned.
-- SAFE: additive, empty-by-default table; the previous application version
-- remains compatible, and the matching .down.sql provides an explicit rollback.
CREATE TABLE IF NOT EXISTS sso_pending_department_assignments (
  tenant_id VARCHAR(50) NOT NULL,
  email VARCHAR(255) NOT NULL,
  department_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  assigned_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS sso_pending_department_assignments_email_idx
  ON sso_pending_department_assignments (email);

-- This table is only reached through the loopback-authenticated internal API
-- and the OIDC callback. Keep it outside the tenant RLS surface; tenant_id is
-- still part of the key and every access path supplies the resolved tenant.
