-- Reverts 20260701000002-phase5-phase6.sql. All additions were nullable/
-- default-valued columns (plus a conditional pgvector column+index), so a
-- straight drop is safe. Any mfa_temp_secret, ai_summary,
-- ai_suggested_metadata, ai_features, or embedding values are lost on the
-- way back down, which is expected — the app code being rolled back to
-- never read these columns anyway.
--
-- The vector extension itself is intentionally left installed (same
-- reasoning as ltree elsewhere in this migration set): it's a
-- database-wide object that may be relied on by other schema, and the up
-- migration only ever did CREATE EXTENSION IF NOT EXISTS conditionally in
-- the first place.
DROP INDEX IF EXISTS idx_doc_versions_embedding;
ALTER TABLE document_versions DROP COLUMN IF EXISTS embedding;

ALTER TABLE tenants DROP COLUMN IF EXISTS ai_features;

ALTER TABLE documents DROP COLUMN IF EXISTS ai_suggested_metadata;
ALTER TABLE documents DROP COLUMN IF EXISTS ai_summary;

ALTER TABLE users DROP COLUMN IF EXISTS mfa_temp_secret;
