-- BUG 2 FIX: Add plaintext_sha256 column to document_versions
-- This column stores the SHA-256 hash of the plaintext document content
-- for duplicate detection and post-decryption integrity verification.

ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS plaintext_sha256 VARCHAR(64);

-- Add index for duplicate detection queries
CREATE INDEX IF NOT EXISTS document_versions_plaintext_hash_idx 
  ON document_versions (plaintext_sha256) 
  WHERE plaintext_sha256 IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- DROP INDEX IF EXISTS document_versions_plaintext_hash_idx;
-- ALTER TABLE document_versions DROP COLUMN IF EXISTS plaintext_sha256;
