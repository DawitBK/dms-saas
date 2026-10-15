-- DMS's own role-management UI (assignRole/removeRole in users.service.ts)
-- wrote to user_roles successfully, but auth.service.ts's OIDC callback
-- unconditionally overwrote it with the SSO id_token's roles claim on the
-- user's very next login -- "worked in the UI, reverted on next sign-in."
-- roles_managed_locally marks that a DMS admin's edit should win; sso_roles_
-- snapshot is what the IdP asserted the last time it actually won, so a
-- later login can tell "SSO hasn't moved since the override" (keep the
-- local edit) apart from "SSO's mapping genuinely changed" (let it win
-- again) -- the two admin surfaces take turns rather than fighting.
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles_managed_locally BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_roles_snapshot TEXT[];
