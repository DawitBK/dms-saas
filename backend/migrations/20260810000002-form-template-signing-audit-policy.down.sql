ALTER TABLE form_templates
  DROP COLUMN IF EXISTS audit_policy,
  DROP COLUMN IF EXISTS signing_policy;
