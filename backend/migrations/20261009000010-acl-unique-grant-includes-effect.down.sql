-- Restoring the old key is only possible while no tuple holds both an ALLOW and a DENY.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM acl_entries
    GROUP BY tenant_id, resource_type, resource_id, principal_type, principal_id, permission
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot restore the old ACL key: some principals hold both an ALLOW and a DENY for the same permission on the same resource. Remove one of each pair first.';
  END IF;
END $$;
ALTER TABLE acl_entries DROP CONSTRAINT IF EXISTS acl_entries_unique_grant;
ALTER TABLE acl_entries
  ADD CONSTRAINT acl_entries_unique_grant
  UNIQUE (tenant_id, resource_type, resource_id, principal_type, principal_id, permission);
