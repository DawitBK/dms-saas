-- Create access_rules table for tenant-wide and document-type-wide permissions
CREATE TABLE IF NOT EXISTS access_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) NOT NULL,
  principal_type VARCHAR(10) NOT NULL CHECK (principal_type IN ('user', 'role')),
  principal_id VARCHAR(255) NOT NULL,
  permission VARCHAR(100) NOT NULL,
  effect VARCHAR(10) NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  document_type_id UUID REFERENCES document_types(id),
  expires_at TIMESTAMPTZ,
  granted_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS access_rules_tenant_idx ON access_rules (tenant_id);
CREATE INDEX IF NOT EXISTS access_rules_principal_idx ON access_rules (tenant_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS access_rules_document_type_idx ON access_rules (document_type_id);
