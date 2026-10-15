-- CAMS: supplementary attachments on a letter, independent of its main
-- content (composed body -> rendered PDF, or SCANNED origin's single
-- staged/final document). Lets a composed letter carry supporting files —
-- "please find attached the invoice" — the same way an email attaches
-- files alongside its written body. A letter can have any number of these.
CREATE TABLE IF NOT EXISTS letter_attachments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          VARCHAR(100) NOT NULL,
  letter_id          UUID        NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  document_id        UUID        NOT NULL REFERENCES documents(id),
  original_filename  TEXT        NOT NULL,
  uploaded_by        UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS letter_attachments_letter_idx ON letter_attachments (letter_id);
CREATE INDEX IF NOT EXISTS letter_attachments_tenant_idx ON letter_attachments (tenant_id);

-- Same RLS pattern as the other direct-tenant_id CAMS tables (20260703000010).
ALTER TABLE letter_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS letter_attachments_tenant_isolation ON letter_attachments;
CREATE POLICY letter_attachments_tenant_isolation ON letter_attachments
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );
