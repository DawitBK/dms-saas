-- Reverts 20260722000001-user-permission-overrides.sql. user_permission_overrides
-- was a brand-new table, so this is a clean drop — no other table has a
-- foreign key into it (users(id) is referenced FROM it, not the reverse).
-- Any per-user permission grants/revokes recorded in it are lost, which is
-- expected since the app code that reads/writes user_permission_overrides
-- (resolveUnionPermissions and its admin API) is also being rolled back.
DROP INDEX IF EXISTS user_permission_overrides_user_idx;
DROP TABLE IF EXISTS user_permission_overrides CASCADE;
