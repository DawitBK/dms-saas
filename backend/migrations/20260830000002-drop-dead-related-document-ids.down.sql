ALTER TABLE document_metadata
  ADD COLUMN IF NOT EXISTS related_document_ids TEXT;
