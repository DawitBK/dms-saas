-- Reverts 20260713000004-feature-flags.sql. Safe: purely additive column,
-- nothing else references it at the database level.
ALTER TABLE tenants DROP COLUMN IF EXISTS feature_flags;
