-- P1-1: bind an in-flight OIDC authorization to the browser that started it.
--
-- oidc_state_nonces previously held only (state, nonce). `state` is unguessable
-- but not bound to anything, so POST /auth/callback accepted a code+state pair
-- from ANY browser. An attacker who completed an authorization for their own
-- account could hand their valid code+state to a victim (crafted link, planted
-- redirect); the victim's browser would redeem it and be signed in as the
-- attacker, then keep working — uploading, approving, signing — inside the
-- attacker's session.
--
-- binding_hash is the SHA-256 (hex, 64 chars) of a token handed to the browser
-- as an httpOnly cookie at GET /auth/oidc/authorize. The callback must present a
-- cookie hashing to this value. Nullable only so rows written by the previous
-- build (and by a rolling deploy) still parse; the callback treats NULL as a
-- failed binding check and refuses the login, so an authorization already in
-- flight across the deploy is rejected rather than waved through.
ALTER TABLE oidc_state_nonces
  ADD COLUMN IF NOT EXISTS binding_hash TEXT;
