-- Document comments / annotations
-- Threaded comments attached to a document, tenant-scoped, soft-deletable.
CREATE TABLE IF NOT EXISTS document_comments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id   VARCHAR(255) NOT NULL,
  author_id   UUID NOT NULL REFERENCES users(id),
  parent_id   UUID REFERENCES document_comments(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  is_deleted  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_comments_document ON document_comments (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_document_comments_tenant   ON document_comments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_parent   ON document_comments (parent_id);
