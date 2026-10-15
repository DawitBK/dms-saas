-- Phase 5: Stitch Documents / document bundles
-- Bundles group ordered documents and compile them into a first-class PDF document.

INSERT INTO retention_policies (code, name, retention_years, is_permanent, trigger_event, disposal_action, authority, is_active)
VALUES ('RET-BUNDLE-5Y', 'Compiled bundles - 5 years', 5, FALSE, 'DOCUMENT_DATE', 'CERTIFIED_DELETION', 'Document Bundle Policy', TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO document_types (tenant_id, code, name, default_retention_class, requires_signature, is_active)
SELECT t.id, 'BUNDLE', 'Compiled Document Bundle', 'RET-BUNDLE-5Y', FALSE, TRUE
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM document_types dt WHERE dt.tenant_id = t.id AND dt.code = 'BUNDLE'
);

CREATE TABLE IF NOT EXISTS document_bundles (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 TEXT        NOT NULL,
  description          TEXT,
  status               TEXT        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COMPILED')),
  compiled_document_id UUID        REFERENCES documents(id) ON DELETE SET NULL,
  created_by           UUID        REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS document_bundles_tenant_idx ON document_bundles (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS document_bundles_compiled_document_idx ON document_bundles (compiled_document_id);

CREATE TABLE IF NOT EXISTS document_bundle_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id   UUID        NOT NULL REFERENCES document_bundles(id) ON DELETE CASCADE,
  document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position    INTEGER     NOT NULL,
  added_by    UUID        REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_bundle_items_bundle_document_uniq UNIQUE (bundle_id, document_id),
  CONSTRAINT document_bundle_items_bundle_position_uniq UNIQUE (bundle_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS document_bundle_items_bundle_idx ON document_bundle_items (bundle_id, position);
CREATE INDEX IF NOT EXISTS document_bundle_items_document_idx ON document_bundle_items (document_id);