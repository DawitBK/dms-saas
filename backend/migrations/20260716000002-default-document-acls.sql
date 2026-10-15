-- Default ACL backfill: freshly uploaded documents had NO acl_entries (only
-- seeded documents got role grants), so every non-admin — including approvers
-- and auditors assigned by the unified approval engine — hit
-- AUTHZ_ACL_NO_ENTRY opening them. createDocument/tus/forms now grant these at
-- creation (grantDefaultDocumentAcl); this backfills existing documents.
-- ON CONFLICT rides the acl_entries_unique_grant constraint.

-- Role read grants (mirrors the seed's per-document pattern).
INSERT INTO acl_entries (tenant_id, resource_type, resource_id, principal_type, principal_id, effect, permission, granted_by_id)
SELECT d.tenant_id, 'document', d.id, 'role', r.role_name, 'ALLOW', 'document:read', d.owner_id
FROM documents d
CROSS JOIN (VALUES ('RECORDS_OFFICER'), ('DEPT_MANAGER'), ('APPROVER'), ('EMPLOYEE'), ('AUDITOR'), ('EXECUTIVE')) AS r(role_name)
WHERE d.owner_id IS NOT NULL
ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id, permission) DO NOTHING;

-- Owner grants: read + version/status + trash on their own document.
INSERT INTO acl_entries (tenant_id, resource_type, resource_id, principal_type, principal_id, effect, permission, granted_by_id)
SELECT d.tenant_id, 'document', d.id, 'user', d.owner_id::text, 'ALLOW', p.permission, d.owner_id
FROM documents d
CROSS JOIN (VALUES ('document:read'), ('document:upload'), ('document:archive')) AS p(permission)
WHERE d.owner_id IS NOT NULL
ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id, permission) DO NOTHING;
