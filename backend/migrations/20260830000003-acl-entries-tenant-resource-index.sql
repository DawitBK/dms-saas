-- acl_entries had separate single/pair indexes on (resource_type,
-- resource_id), (principal_type, principal_id), tenant_id, and expires_at,
-- but no index leading with tenant_id and covering resource_type/resource_id
-- together — the exact shape resolveACL.ts's two hot queries filter on
-- (`WHERE permission = ? AND tenantId = ? AND resourceType = ? AND
-- resourceId = ? AND ...`). This strictly generalizes the existing
-- single-column indexes for that access pattern.
CREATE INDEX IF NOT EXISTS acl_entries_tenant_resource_idx
  ON acl_entries (tenant_id, resource_type, resource_id);
