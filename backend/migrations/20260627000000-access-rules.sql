-- Migration: Access Rules for tenant-wide and document-type-wide permissions
-- Sprint: EDAMS Hierarchical Org Structure
-- Purpose: Enable broad-scope permission grants that apply across multiple resources

-- ============================================================================
-- Create access_rules table
-- ============================================================================

CREATE TABLE IF NOT EXISTS access_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  
  -- Principal (who gets the permission)
  principal_type VARCHAR(10) NOT NULL CHECK (principal_type IN ('user', 'role')),
  principal_id VARCHAR(100) NOT NULL,
  
  -- Permission and effect
  permission VARCHAR(100) NOT NULL,
  effect VARCHAR(10) NOT NULL CHECK (effect IN ('ALLOW', 'DENY')),
  
  -- Scope (what the permission applies to)
  document_type_id UUID REFERENCES document_types(id) ON DELETE CASCADE,  -- nullable: if set, applies to all documents of this type
  -- If document_type_id is NULL, the rule is tenant-wide
  
  -- Audit and lifecycle
  expires_at TIMESTAMPTZ,
  granted_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Indexes for access_rules
-- ============================================================================

-- Primary lookup: find rules for a principal
CREATE INDEX idx_access_rules_principal ON access_rules(tenant_id, principal_type, principal_id);

-- Secondary lookup: find rules by document type
CREATE INDEX idx_access_rules_document_type ON access_rules(tenant_id, document_type_id) WHERE document_type_id IS NOT NULL;

-- Tertiary lookup: find tenant-wide rules
CREATE INDEX idx_access_rules_tenant_wide ON access_rules(tenant_id) WHERE document_type_id IS NULL;

-- Expiry cleanup
CREATE INDEX idx_access_rules_expires ON access_rules(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE access_rules IS 'Tenant-wide and document-type-wide permission rules that apply broadly across resources';
COMMENT ON COLUMN access_rules.document_type_id IS 'If set, rule applies to all documents of this type tenant-wide. If NULL, rule is tenant-wide for that permission.';
COMMENT ON COLUMN access_rules.effect IS 'ALLOW or DENY - checked as lower-priority fallback after resource-specific ACL resolution';
