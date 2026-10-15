-- P2-9 item 24: PKCE for DMS's OIDC authorization-code flow.
--
-- GET /auth/oidc/authorize sent no code_challenge. That is why SSO's
-- oidc-provider config could observe, in its own comment, that `pkce.required`
-- was enforced for nobody: the predicate only demands PKCE from clients using
-- token_endpoint_auth_method 'none', and every seeded client uses
-- client_secret_post. Correct policy, zero effect.
--
-- code_verifier is the server-side half of the exchange: generated at authorize
-- time, stored beside the state/nonce, and replayed to the token endpoint so the
-- IdP can check it against the S256 challenge it saw earlier. It is a short-lived
-- secret with exactly the lifetime of the row.
--
-- Nullable, so a pending row written by the previous build still completes its
-- token exchange (the callback omits code_verifier when it is absent) and a
-- rolling deploy does not fail every in-flight login.
ALTER TABLE oidc_state_nonces
  ADD COLUMN IF NOT EXISTS code_verifier TEXT;
