-- Removes the origin column. The owner document:checkout rows are left in place:
-- they are indistinguishable from grants an administrator may have added since.
ALTER TABLE acl_entries DROP COLUMN IF EXISTS origin;
