-- Reverts 20260714000001-oidc-state-nonces.sql. Safe: standalone table, nothing
-- else references it at the database level.
DROP TABLE IF EXISTS oidc_state_nonces;
