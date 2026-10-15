-- Add document_date field to documents table for document date retention and metadata
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS document_date TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS documents_document_date_idx ON documents (document_date);
