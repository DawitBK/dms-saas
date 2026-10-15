-- H8: make the two-person destruction rule exercisable. RECORDS_OFFICER now
-- holds document:purge (config/permissions.ts); grant the matching per-document
-- role ACL on existing documents so a records officer can stage/approve a purge
-- (a second officer or a SYSTEM_ADMIN is the required distinct approver).
INSERT INTO acl_entries (tenant_id, resource_type, resource_id, principal_type, principal_id, effect, permission, granted_by_id)
SELECT d.tenant_id, 'document', d.id, 'role', 'RECORDS_OFFICER', 'ALLOW', 'document:purge', d.owner_id
FROM documents d
WHERE d.owner_id IS NOT NULL
ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id, permission) DO NOTHING;
