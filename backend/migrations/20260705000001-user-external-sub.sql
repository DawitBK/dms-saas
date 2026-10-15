-- Persist the OIDC IdP subject on JIT-provisioned users. The /auth/callback
-- handler already writes `externalSub` on User.create(...); this adds the
-- backing column so it is stored instead of silently dropped.
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_sub VARCHAR(255);

-- Stable re-linking even if an email changes at the IdP. Partial unique index
-- (only non-null values must be unique).
CREATE UNIQUE INDEX IF NOT EXISTS users_external_sub_unique
  ON users (external_sub) WHERE external_sub IS NOT NULL;
