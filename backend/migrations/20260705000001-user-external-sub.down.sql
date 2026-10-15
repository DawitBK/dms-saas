-- Reverts 20260705000001-user-external-sub.sql. Safe: a nullable column plus
-- a partial unique index on top of it, purely additive — nothing else
-- depends on them existing at the database level. Any externalSub values
-- persisted for JIT-provisioned SSO users are lost on rollback, which is
-- expected (the /auth/callback handler that writes it goes back to silently
-- dropping the value, exactly as it did before this column existed — stable
-- re-linking across an IdP email change simply becomes unavailable again).
DROP INDEX IF EXISTS users_external_sub_unique;
ALTER TABLE users DROP COLUMN IF EXISTS external_sub;
