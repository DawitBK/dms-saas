-- Phase 2 fix: form instances are filed as first-class Documents, but the
-- insert was missing NOT NULL columns (documentName/title/departmentId/
-- documentTypeId) behind an `as any` cast and failed at the DB every time.
-- Seed the FORM document type + retention policy the corrected filing needs.

INSERT INTO retention_policies (code, name, retention_years, is_permanent, trigger_event, disposal_action, authority, is_active)
VALUES ('RET-FORM-5Y', 'Forms — 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'Forms Governance Policy', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'FORM', 'Generated Form', 'RET-FORM-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'FORM'
);
