-- Reverts 20260626000003-role-permissions.sql. Purely additive table +
-- index, so a straight drop undoes it cleanly; any role_permissions rows
-- inserted since are lost, which is expected on rollback.
DROP INDEX IF EXISTS role_permissions_role_idx;
DROP TABLE IF EXISTS role_permissions CASCADE;
