-- Restore the normal document ACL contract for bundles compiled before the
-- bundle compiler reused grantDefaultDocumentAcl. Those rows are valid
-- first-class documents but previously had no owner/department grants, so a
-- detail/download request failed closed with AUTHZ_ACL_NO_ENTRY.
-- SAFE: idempotent owner and department-member ALLOW rows only; no existing
-- DENY or unrelated ACL entry is changed. The down migration is intentionally
-- irreversible because these rows are indistinguishable from legitimate
-- creation-time grants once inserted.

INSERT INTO acl_entries (
  tenant_id, resource_type, resource_id, principal_type, principal_id,
  effect, permission, granted_by_id
)
SELECT d.tenant_id, 'document', d.id, 'user', d.owner_id::text,
       'ALLOW', 'document:read', d.owner_id
FROM documents d
JOIN document_types dt ON dt.id = d.document_type_id
WHERE dt.code = 'BUNDLE'
  AND d.owner_id IS NOT NULL
ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id, permission)
DO NOTHING;

INSERT INTO acl_entries (
  tenant_id, resource_type, resource_id, principal_type, principal_id,
  effect, permission, granted_by_id
)
SELECT d.tenant_id, 'document', d.id, 'user', ud.user_id::text,
       'ALLOW', 'document:read', d.owner_id
FROM documents d
JOIN document_types dt ON dt.id = d.document_type_id
JOIN user_departments ud ON ud.department_id = d.department_id
WHERE dt.code = 'BUNDLE'
  AND d.owner_id IS NOT NULL
  AND ud.user_id <> d.owner_id
ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id, permission)
DO NOTHING;
