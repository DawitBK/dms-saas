-- idp_role_mappings was UNIQUE(relying_party, ad_group_dn) -- one row per
-- group/per-user-override, and since role_name is NOT NULL, that meant
-- exactly one DMS role per group. DMS's own user_roles is many-to-many (a
-- user can hold SYSTEM_ADMIN and DEPT_MANAGER simultaneously, as real
-- accounts on this tenant do), but the per-user "CN=user:<sub>" override
-- convenience mapping could only ever assert ONE of them -- discovered live
-- when a SYSTEM_ADMIN+DEPT_MANAGER account's per-user mapping asserted
-- DEPT_MANAGER only, meaning their next SSO login would have silently
-- reverted user_roles down to DEPT_MANAGER, stripping SYSTEM_ADMIN with no
-- warning. Widening the key to include role_name lets one group (or one
-- per-user override) carry multiple rows -- multiple simultaneously-true
-- roles -- exactly mirroring what user_roles already supports.
--
-- /role-mappings/resolve (internal.routes.ts) already does
-- `SELECT DISTINCT role_name ... WHERE ad_group_dn = ANY(...)` and already
-- returns an array, so login-time role resolution needs no change here --
-- it was only ever the WRITE side (the single-row-per-group PUT endpoint
-- and the admin UIs built against it) that couldn't express more than one
-- role per group in the first place.
ALTER TABLE idp_role_mappings DROP CONSTRAINT idp_role_mappings_relying_party_ad_group_dn_key;
ALTER TABLE idp_role_mappings ADD CONSTRAINT idp_role_mappings_relying_party_ad_group_dn_role_name_key
  UNIQUE (relying_party, ad_group_dn, role_name);
