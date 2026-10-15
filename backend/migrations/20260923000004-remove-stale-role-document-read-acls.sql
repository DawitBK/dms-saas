-- Remove the legacy tenant-wide role grants that defeated department scope.
--
-- 20260716000002-default-document-acls.sql and the original
-- grantDefaultDocumentAcl helper granted document:read directly to the
-- RECORDS_OFFICER, DEPT_MANAGER, APPROVER, EMPLOYEE, AUDITOR, and EXECUTIVE
-- role principals on every document.  A role ACL has no department dimension,
-- so it made every holder of one of those roles a reader of every document in
-- the tenant.  The application helper was corrected to grant live department
-- membership/owner access instead; this migration removes the historical rows
-- left behind by the old behavior.
--
-- This predicate is intentionally exact. It leaves user grants, department or
-- folder grants, DENY entries, purge grants, custom-role entries, and all other
-- permissions untouched.
-- SAFE: this is an intentional, exact security cleanup of only the legacy
-- blanket role ALLOW rows described above; the non-destructive application
-- grants and all other ACL shapes remain intact, and the down migration is
-- intentionally forward-only so rollback cannot restore the vulnerability.
DELETE FROM acl_entries
WHERE resource_type = 'document'
  AND principal_type = 'role'
  AND principal_id IN (
    'RECORDS_OFFICER', 'DEPT_MANAGER', 'APPROVER',
    'EMPLOYEE', 'AUDITOR', 'EXECUTIVE'
  )
  AND permission = 'document:read'
  AND effect = 'ALLOW';
