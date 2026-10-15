-- Postgres-backed fallback for the OIDC authorize/callback CSRF state+nonce
-- pair. Previously this lived only in Redis (getCacheRedis()); when Redis is
-- unreachable the SSO login flow failed closed with a 500/503 instead of
-- degrading, unlike every other cache in this codebase. This table lets
-- storeOidcState/consumeOidcState (auth.routes.ts) fall back to Postgres so
-- SSO keeps working — with the same CSRF guarantee — when Redis is down.
CREATE TABLE IF NOT EXISTS oidc_state_nonces (
  state       TEXT        PRIMARY KEY,
  nonce       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oidc_state_nonces_expires_idx ON oidc_state_nonces (expires_at);
