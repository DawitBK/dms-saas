-- Reverts 20260701000003-idp-role-mappings.sql: drops idp_clients,
-- oidc_grants, and idp_role_mappings (including its seeded EDAMS role-
-- mapping rows, which are dropped along with the table rather than
-- individually deleted since nothing else in this batch references them).
-- Note: 'edams' here is the DMS/EDAMS relying-party id used throughout the
-- SSO/DMS token contract per this repo's naming convention — left as-is,
-- not renamed.
--
-- Any idp_role_mappings rows added by admins since this migration ran, any
-- oidc_grants issued by the production oidc-provider, and any idp_clients
-- registered since are all lost on the way back down. That's expected for
-- a rollback of the migration that created these tables in the first
-- place — there is nothing upstream of this migration for that data to be
-- restored from.
DROP TABLE IF EXISTS idp_clients CASCADE;

DROP INDEX IF EXISTS oidc_grants_expires_idx;
DROP INDEX IF EXISTS oidc_grants_kind_idx;
DROP TABLE IF EXISTS oidc_grants CASCADE;

DROP INDEX IF EXISTS idp_role_mappings_rp_idx;
DROP TABLE IF EXISTS idp_role_mappings CASCADE;
