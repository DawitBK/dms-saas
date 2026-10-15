ALTER TABLE oidc_state_nonces
  DROP COLUMN IF EXISTS binding_hash;
