-- CAMS: images inserted directly into a letter's rich-text Body (the
-- structured-document editor, letterBodyDoc.ts) — distinct from
-- letter_attachments (20260713000002), which files a supporting document
-- alongside the letter the way an email attachment does. A body image is
-- part of the letter's own content, not a separate filed record: it does
-- NOT create a `documents` row (so it never appears in the Documents
-- dashboard/My Files/Browse — it isn't a document, it's part of one), isn't
-- retention/legal-hold-managed, and is stored via the plain StorageAdapter
-- rather than the encrypted document-crypto pipeline. Referenced from the
-- doc JSON by this table's id (an image node's `src` is
-- `/letters/body-images/:id`).
CREATE TABLE IF NOT EXISTS letter_body_images (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          VARCHAR(100) NOT NULL,
  uploaded_by        UUID        NOT NULL REFERENCES users(id),
  mime_type          VARCHAR(100) NOT NULL,
  size_bytes         BIGINT      NOT NULL,
  storage_key        TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS letter_body_images_tenant_idx ON letter_body_images (tenant_id);
CREATE INDEX IF NOT EXISTS letter_body_images_uploaded_by_idx ON letter_body_images (uploaded_by);

-- Same RLS pattern as letter_attachments and the other direct-tenant_id CAMS
-- tables (20260703000010).
ALTER TABLE letter_body_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS letter_body_images_tenant_isolation ON letter_body_images;
CREATE POLICY letter_body_images_tenant_isolation ON letter_body_images
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );
