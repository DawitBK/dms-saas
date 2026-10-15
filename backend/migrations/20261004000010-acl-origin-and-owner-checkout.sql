-- Two related repairs to document ACLs.
--
-- 1. acl_entries.origin. grantDefaultDocumentAcl writes a document:read row for
--    every member of the document's department at creation time (a snapshot).
--    resolveACL enforces a live department boundary on top of those rows, so a
--    person who later leaves the department stops reading the document even
--    though their snapshot row remains. The same boundary also swallowed every
--    OTHER explicit per-user read grant (approval participants, auditors,
--    signatories, Access Control Center grants) for anyone outside the
--    department, because a snapshot row and a deliberate grant looked identical.
--    The new column marks the snapshot rows so the boundary can tell them apart:
--    origin = 'DEPT_SNAPSHOT' is bound by the live department check, anything
--    else (NULL) is a deliberate grant and is honoured outside the department.
--    Existing rows: a user ALLOW document:read row granted by the owner to a
--    CURRENT member of the document's department is a snapshot; everything else
--    stays a deliberate grant. (A snapshot row of someone who already left
--    cannot be recognised and therefore keeps behaving as it did before.)
-- 2. Owners never received document:checkout, so only admins could check a
--    document out (and therefore upload a version, which requires a checkout).
--    Give every owner the grant on documents they already hold upload on.
-- SAFE: additive nullable column, idempotent inserts, no existing row removed.
ALTER TABLE acl_entries ADD COLUMN IF NOT EXISTS origin varchar(20);

UPDATE acl_entries a
SET origin = 'DEPT_SNAPSHOT'
FROM documents d
WHERE a.resource_type = 'document'
  AND a.resource_id = d.id
  AND a.principal_type = 'user'
  AND a.permission = 'document:read'
  AND a.effect = 'ALLOW'
  AND a.origin IS NULL
  AND a.granted_by_id = d.owner_id
  AND a.principal_id <> d.owner_id::text
  AND EXISTS (
    SELECT 1 FROM user_departments ud
    WHERE ud.user_id::text = a.principal_id AND ud.department_id = d.department_id
  );

INSERT INTO acl_entries (
  tenant_id, resource_type, resource_id, principal_type, principal_id,
  effect, permission, granted_by_id
)
SELECT a.tenant_id, 'document', a.resource_id, 'user', a.principal_id,
       'ALLOW', 'document:checkout', a.granted_by_id
FROM acl_entries a
JOIN documents d ON d.id = a.resource_id AND a.principal_id = d.owner_id::text
WHERE a.resource_type = 'document'
  AND a.principal_type = 'user'
  AND a.permission = 'document:upload'
  AND a.effect = 'ALLOW'
ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id, permission)
DO NOTHING;
