-- Per-user permission overrides: grant/revoke individual permissions for one
-- person on top of whatever their role(s) already resolve to. Mirrors
-- role_permissions (20260626000003-role-permissions.sql) but scoped to a user.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL,
  effect VARCHAR(10) NOT NULL CHECK (effect IN ('GRANT', 'REVOKE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_id, permission)
);

CREATE INDEX IF NOT EXISTS user_permission_overrides_user_idx ON user_permission_overrides (tenant_id, user_id);
