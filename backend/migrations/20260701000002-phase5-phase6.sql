-- Phase 5 & 6: Enterprise features, 2FA, AI columns
-- 2FA setup secret (temporary until user confirms)
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_temp_secret VARCHAR(255) NULL;

-- AI-generated fields on documents
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ai_summary TEXT NULL,
  ADD COLUMN IF NOT EXISTS ai_suggested_metadata JSONB NULL;

-- Per-tenant AI feature flags
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS ai_features JSONB DEFAULT '{}' NULL;

-- pgvector semantic search (conditional — skip if extension unavailable)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS embedding vector(1536) NULL;
    CREATE INDEX IF NOT EXISTS idx_doc_versions_embedding
      ON document_versions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  END IF;
END $$;
