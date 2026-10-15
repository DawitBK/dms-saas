-- An ACL entry was unique on (tenant, resource, principal, permission). The effect was not part of the
-- key, so once someone held an ALLOW for a permission on a resource, a DENY for the same permission could
-- not be added beside it (409 ERR-ACL-GRANT-EXISTS): the owner had to delete the ALLOW first, which
-- also removed the person's access in the gap. The resolver already evaluates DENY before ALLOW, so both
-- rows can coexist. The key now includes the effect: at most one ALLOW and one DENY per tuple.
ALTER TABLE acl_entries DROP CONSTRAINT IF EXISTS acl_entries_unique_grant;
ALTER TABLE acl_entries
  ADD CONSTRAINT acl_entries_unique_grant
  UNIQUE (tenant_id, resource_type, resource_id, principal_type, principal_id, permission, effect);
