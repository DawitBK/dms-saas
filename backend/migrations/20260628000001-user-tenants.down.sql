-- Reverts 20260628000001-user-tenants.sql. Purely additive join table +
-- indexes + comments; dropping the table removes all of it (comments
-- included). Any user_tenants membership rows created since are lost,
-- which is expected on rollback.
DROP INDEX IF EXISTS idx_user_tenants_tenant_id;
DROP INDEX IF EXISTS idx_user_tenants_user_id;
DROP TABLE IF EXISTS user_tenants CASCADE;
