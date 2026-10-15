-- Finding 3: access_rules had no uniqueness constraint on the tuple that
-- actually defines "one grant" (tenant_id, principal_type, principal_id,
-- permission, document_type_id) -- every sibling permission table
-- (acl_entries, role_permissions, user_permission_overrides) already enforces
-- this; access_rules was the outlier. Without it, POSTing a new rule over the
-- same tuple (e.g. flipping ALLOW -> DENY) just inserts a second,
-- now-contradictory row under a new id instead of replacing the first, and
-- resolveACL.ts's DENY-sorts-first resolution means a stale DENY can silently
-- and permanently win over a later ALLOW with zero error signal.
--
-- Two partial unique indexes, not one plain unique index, because
-- document_type_id is nullable (NULL = tenant-wide grant) and a plain
-- multi-column UNIQUE INDEX treats every NULL as distinct from every other
-- NULL -- it would happily let in unlimited duplicate tenant-wide rows for
-- the same principal+permission, the exact case (a tenant-wide DENY vs a
-- tenant-wide ALLOW) called out in the finding.
--
-- If this fails with a uniqueness violation, existing data already has
-- contradictory/duplicate rows for the same tuple; find them first:
--   SELECT tenant_id, principal_type, principal_id, permission, document_type_id, COUNT(*)
--     FROM access_rules
--    GROUP BY tenant_id, principal_type, principal_id, permission, document_type_id
--   HAVING COUNT(*) > 1;
-- and resolve (keep the most recent / most permissive, per whatever policy
-- the tenant admin confirms) before retrying -- per the remediation plan,
-- failing loudly here is the correct, safe behavior, not something to
-- dedup automatically as part of this migration.
CREATE UNIQUE INDEX IF NOT EXISTS access_rules_tuple_unique_scoped_idx
  ON access_rules (tenant_id, principal_type, principal_id, permission, document_type_id)
  WHERE document_type_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS access_rules_tuple_unique_global_idx
  ON access_rules (tenant_id, principal_type, principal_id, permission)
  WHERE document_type_id IS NULL;
