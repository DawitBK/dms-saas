-- S3-02: acl_entries table (TDD §4.2.6)
-- Run manually until Sequelize migration baseline lands in Sprint 6.

CREATE TABLE IF NOT EXISTS acl_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  principal_type VARCHAR(20) NOT NULL,
  principal_id VARCHAR(100) NOT NULL,
  effect VARCHAR(10) NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  permission VARCHAR(50) NOT NULL,
  expires_at TIMESTAMPTZ,
  granted_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT acl_entries_unique_grant UNIQUE (
    tenant_id, resource_type, resource_id, principal_type, principal_id, permission
  )
);

CREATE INDEX IF NOT EXISTS acl_entries_resource_idx ON acl_entries (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS acl_entries_principal_idx ON acl_entries (principal_type, principal_id);
CREATE INDEX IF NOT EXISTS acl_entries_tenant_idx ON acl_entries (tenant_id);
CREATE INDEX IF NOT EXISTS acl_entries_expires_idx ON acl_entries (expires_at);

-- down()
-- DROP TABLE IF EXISTS acl_entries;
