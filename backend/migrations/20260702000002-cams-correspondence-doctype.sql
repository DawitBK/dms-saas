-- CAMS Phase 2: approved letters are filed into the document store as real
-- documents. Seed the document type + retention policy that filing depends on.

INSERT INTO retention_policies (code, name, retention_years, is_permanent, trigger_event, disposal_action, authority, is_active)
VALUES ('RET-CORR-5Y', 'Correspondence — 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'CAMS Correspondence Policy', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'CORR', 'Correspondence', 'RET-CORR-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'CORR'
);
