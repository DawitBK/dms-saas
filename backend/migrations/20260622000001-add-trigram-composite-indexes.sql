-- Additional performance indexes for EDAMS
-- Add trigram indexes for search and composite index for listDocuments

-- Enable pg_trgm extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Composite index for listDocuments hot path
CREATE INDEX IF NOT EXISTS idx_documents_tenant_deleted_updated ON documents(tenant_id, deleted_at, updated_at DESC);

-- Trigram indexes for search on documents table
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_document_name_trgm ON documents USING GIN (document_name gin_trgm_ops);

-- Trigram indexes for search on document_metadata table
CREATE INDEX IF NOT EXISTS idx_document_metadata_keywords_trgm ON document_metadata USING GIN (keywords gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_document_metadata_description_trgm ON document_metadata USING GIN (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_document_metadata_tags_trgm ON document_metadata USING GIN (tags gin_trgm_ops);
