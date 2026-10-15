-- Per-tenant configurable "only these roles may perform this action when a
-- document is in this status" rules — e.g. "only SYSTEM_ADMIN and DEPT_MANAGER
-- may checkout a document while it's ARCHIVED". Absence of any row for a
-- (tenant, status, action) tuple means unrestricted (normal RBAC/ACL rules
-- apply as they always have); presence of rows restricts that action to
-- exactly the listed roles, on top of (not instead of) whatever RBAC/ACL
-- would otherwise allow. See statusPermissions.service.ts's
-- assertStatusPermission for the enforcement side.
CREATE TABLE IF NOT EXISTS document_status_action_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  role_name VARCHAR(64) NOT NULL,
  created_by_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, status, action, role_name)
);

CREATE INDEX IF NOT EXISTS doc_status_action_roles_lookup_idx
  ON document_status_action_roles (tenant_id, status, action);

-- RLS, matching every other tenant_id-bearing table (see
-- 20260710000001-rls-remaining-tenant-tables.sql's role_permissions policy,
-- which this mirrors exactly, including the pre-tenant-context escape valve).
ALTER TABLE document_status_action_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_status_action_roles_tenant_isolation ON document_status_action_roles;
CREATE POLICY document_status_action_roles_tenant_isolation ON document_status_action_roles
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );
