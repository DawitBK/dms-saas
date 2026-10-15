ALTER TABLE idempotency_keys
  DROP COLUMN IF EXISTS body_hash;
