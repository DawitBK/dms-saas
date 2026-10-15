-- shared/idempotency.middleware.ts's key-reuse check only compared userId and
-- endpoint, not the request body — the same key, user, and endpoint reused
-- with a genuinely DIFFERENT body silently replayed the first response
-- instead of being rejected. body_hash (sha256 of the request body, hex) lets
-- the middleware detect that case too. Nullable: rows written by an
-- already-in-flight request during a rolling deploy (old code, no hash) must
-- not break the comparison — a null stored hash is treated as "nothing to
-- compare", not a mismatch.
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS body_hash VARCHAR(64);
