-- Create role_permissions table for dynamic role permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id),
  permission VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, role_id, permission)
);

CREATE INDEX IF NOT EXISTS role_permissions_role_idx ON role_permissions (tenant_id, role_id);
