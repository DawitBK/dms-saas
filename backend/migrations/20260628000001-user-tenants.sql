-- Migration: Create user_tenants table for multi-tenant membership
-- EDAMS v3 §2: Real Multi-Tenancy

-- Create user_tenants join table (mirrors UserDepartment/UserRole pattern)
CREATE TABLE IF NOT EXISTS user_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR(50) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, tenant_id)
);

CREATE INDEX idx_user_tenants_user_id ON user_tenants(user_id);
CREATE INDEX idx_user_tenants_tenant_id ON user_tenants(tenant_id);

COMMENT ON TABLE user_tenants IS 'User-to-tenant membership mapping for multi-tenant access';
COMMENT ON COLUMN user_tenants.user_id IS 'User who has access to the tenant';
COMMENT ON COLUMN user_tenants.tenant_id IS 'Tenant the user can access';
COMMENT ON COLUMN user_tenants.assigned_at IS 'When this membership was granted';
COMMENT ON COLUMN user_tenants.assigned_by IS 'Admin who granted this membership';
