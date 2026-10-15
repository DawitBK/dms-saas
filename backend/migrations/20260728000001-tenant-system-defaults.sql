-- Fix: FORM/BUNDLE/CORR document types were only ever backfilled onto tenants
-- that existed at the time their respective migrations ran (WHERE NOT EXISTS
-- against `tenants`, a one-time snapshot) — createTenant() never seeded them,
-- so any tenant created after those migrations shipped is missing them and
-- forms/bundles/letters filing 500s with ERR-DOCTYPE-*-MISSING. This
-- re-applies the same backfill (harmless no-op for tenants that already have
-- the rows) as a safety net, and adds the new UNCATEGORIZED bucket used by
-- e-signing's direct-upload path when the optional department/type fields
-- are skipped. createTenant() (tenants.service.ts) now also seeds all of
-- these for tenants created from here on.

INSERT INTO retention_policies (code, name, retention_years, is_permanent, trigger_event, disposal_action, authority, is_active)
VALUES
  ('RET-FORM-5Y', 'Forms — 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'Forms Governance Policy', TRUE),
  ('RET-CORR-5Y', 'Correspondence — 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'CAMS Correspondence Policy', TRUE),
  ('RET-BUNDLE-5Y', 'Compiled bundles - 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'Document Bundle Policy', TRUE),
  ('RET-UNCAT-5Y', 'Uncategorized signed documents — 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'E-Signing Uncategorized Bucket Policy', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'FORM', 'Generated Form', 'RET-FORM-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'FORM');

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'CORR', 'Correspondence', 'RET-CORR-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'CORR');

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'BUNDLE', 'Compiled Document Bundle', 'RET-BUNDLE-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'BUNDLE');

-- One fixed fallback bucket per tenant for e-signing's direct-upload path:
-- a dedicated department (under the tenant's HQ org unit) + document type,
-- used whenever the uploader skips the optional department/type fields.
INSERT INTO departments (id, tenant_id, org_unit_id, code, name, description, is_active)
SELECT gen_random_uuid(), t.id, ou.id, 'UNCAT', 'Uncategorized',
       'Fallback department for e-signing uploads that skip department/type/folder selection', TRUE
FROM tenants t
JOIN LATERAL (
  SELECT id FROM org_units WHERE tenant_id = t.id ORDER BY (unit_type = 'HQ') DESC, created_at ASC LIMIT 1
) ou ON TRUE
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.tenant_id = t.id AND d.code = 'UNCAT');

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'SIGN-UNCAT', 'Uncategorized Signed Document', 'RET-UNCAT-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'SIGN-UNCAT');
