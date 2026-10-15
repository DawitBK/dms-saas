-- Best-effort: remove only the default grants this migration (or the default
-- grant helper) created — identified by granted_by = the document's owner.
DELETE FROM acl_entries a
USING documents d
WHERE a.resource_type = 'document' AND a.resource_id = d.id
  AND a.granted_by_id = d.owner_id
  AND a.effect = 'ALLOW'
  AND a.permission IN ('document:read', 'document:upload', 'document:archive');
