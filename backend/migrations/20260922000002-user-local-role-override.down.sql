-- Reverts 20260922000002-user-local-role-override.sql. Safe: purely
-- additive columns, nothing else references them.
ALTER TABLE users DROP COLUMN IF EXISTS sso_roles_snapshot;
ALTER TABLE users DROP COLUMN IF EXISTS roles_managed_locally;
