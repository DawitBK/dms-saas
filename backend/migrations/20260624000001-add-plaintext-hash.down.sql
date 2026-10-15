-- Reverts 20260624000001-add-plaintext-hash.sql. Safe: purely additive
-- (nullable column, partial index) — nothing else depends on it existing at
-- the database level. Any plaintext_sha256 values computed for duplicate
-- detection are lost, which is expected since the app code that reads this
-- column is also being rolled back.
DROP INDEX IF EXISTS document_versions_plaintext_hash_idx;
ALTER TABLE document_versions DROP COLUMN IF EXISTS plaintext_sha256;
