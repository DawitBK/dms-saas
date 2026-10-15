-- Reverts 20260611000001-create-acl-entries.sql. acl_entries was a brand-new
-- table, so this is a clean drop — no other table has a foreign key into it.
-- CASCADE is used because later migrations (e.g. RLS policies) attach objects
-- (policies) directly to this table; any ACL grants recorded in it are lost,
-- which is expected since the app code that reads acl_entries is also being
-- rolled back.
DROP INDEX IF EXISTS acl_entries_expires_idx;
DROP INDEX IF EXISTS acl_entries_tenant_idx;
DROP INDEX IF EXISTS acl_entries_principal_idx;
DROP INDEX IF EXISTS acl_entries_resource_idx;
DROP TABLE IF EXISTS acl_entries CASCADE;
