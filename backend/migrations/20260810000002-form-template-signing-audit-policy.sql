-- Per-template governance policies (SYSTEM-DECISIONS.md D5/D8), mirroring
-- document_types' columns of the same name. Previously a form instance's
-- audit/signing requirement was resolved from the single tenant-wide FORM
-- document type, forcing every form template to share one setting
-- regardless of what the form is for.
ALTER TABLE form_templates
  ADD COLUMN IF NOT EXISTS audit_policy VARCHAR(10) NOT NULL DEFAULT 'never',
  ADD COLUMN IF NOT EXISTS signing_policy VARCHAR(10) NOT NULL DEFAULT 'none';
