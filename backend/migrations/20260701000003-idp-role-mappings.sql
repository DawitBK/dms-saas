-- Phase 6: IdP role mapping + oidc_grants schema
--
-- idp_role_mappings: maps an AD group DN to an EDAMS role, scoped per relying party.
-- When an OIDC-provisioned user logs in, EDAMS checks this table to assign the correct
-- role instead of defaulting to EMPLOYEE.
--
-- oidc_grants: Postgres-backed adapter storage for the production oidc-provider service.
-- Kept here so the IdP and EDAMS share one Postgres instance in the initial deployment.

-- Role mappings (keyed per RP because EDAMS / GMS / Retail OS have different role vocabularies)
CREATE TABLE IF NOT EXISTS idp_role_mappings (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  relying_party    TEXT        NOT NULL,  -- client_id of the RP, e.g. 'edams'
  ad_group_dn      TEXT        NOT NULL,  -- full DN, e.g. 'CN=EDAMS_Admins,OU=Groups,DC=examplecorp,DC=com'
  role_name        TEXT        NOT NULL,  -- EDAMS role name, e.g. 'SYSTEM_ADMIN'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (relying_party, ad_group_dn)
);

CREATE INDEX IF NOT EXISTS idp_role_mappings_rp_idx ON idp_role_mappings (relying_party);

-- Seed default mappings for the EDAMS relying party (matches scaffold test users)
INSERT INTO idp_role_mappings (relying_party, ad_group_dn, role_name) VALUES
  ('edams', 'CN=EDAMS_Admins,OU=Groups,DC=examplecorp,DC=com',   'SYSTEM_ADMIN'),
  ('edams', 'CN=EDAMS_Records,OU=Groups,DC=examplecorp,DC=com',  'RECORDS_OFFICER'),
  ('edams', 'CN=EDAMS_Managers,OU=Groups,DC=examplecorp,DC=com', 'DEPT_MANAGER'),
  ('edams', 'CN=EDAMS_Approvers,OU=Groups,DC=examplecorp,DC=com','APPROVER'),
  ('edams', 'CN=EDAMS_Employees,OU=Groups,DC=examplecorp,DC=com','EMPLOYEE'),
  ('edams', 'CN=EDAMS_Auditors,OU=Groups,DC=examplecorp,DC=com', 'AUDITOR')
ON CONFLICT (relying_party, ad_group_dn) DO NOTHING;

-- oidc_grants: used by the production oidc-provider PostgresAdapter.
-- Also used by the identity/ scaffold for its in-memory fallback schema reference.
CREATE TABLE IF NOT EXISTS oidc_grants (
  id          TEXT        PRIMARY KEY,
  kind        TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  expires_at  TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oidc_grants_kind_idx ON oidc_grants (kind);
CREATE INDEX IF NOT EXISTS oidc_grants_expires_idx ON oidc_grants (expires_at) WHERE expires_at IS NOT NULL;

-- idp_clients: registered OIDC relying parties (populated by seed / admin API in Phase 6+)
CREATE TABLE IF NOT EXISTS idp_clients (
  client_id     TEXT        PRIMARY KEY,
  client_secret TEXT        NOT NULL,
  redirect_uris TEXT[]      NOT NULL DEFAULT '{}',
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
