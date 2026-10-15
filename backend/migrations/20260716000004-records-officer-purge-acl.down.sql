DELETE FROM acl_entries
WHERE resource_type = 'document'
  AND principal_type = 'role'
  AND principal_id = 'RECORDS_OFFICER'
  AND permission = 'document:purge';
