-- Phase 7: Forms engine
--
-- form_templates: authored by RECORDS_OFFICER/admin, approved via the existing workflow.
--   base_pdf_object_key: optional pre-existing PDF base (MinIO key); null = generate blank.
--   schema_json: pdfme Template JSON — array of named field descriptors (type, position, size).
--   layout_mode: 'static' (positions fixed at authoring) | 'dynamic' (positions resolved per instance).
--
-- form_instances: a completed form = a first-class document.
--   template_version is frozen at creation time so later template edits don't mutate past instances.

CREATE TABLE IF NOT EXISTS form_templates (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  category            TEXT,
  base_pdf_object_key TEXT,
  schema_json         JSONB       NOT NULL DEFAULT '[]',
  layout_mode         TEXT        NOT NULL DEFAULT 'static' CHECK (layout_mode IN ('static', 'dynamic')),
  version             INTEGER     NOT NULL DEFAULT 1,
  status              TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'active', 'deprecated')),
  created_by          UUID        REFERENCES users(id),
  approved_by         UUID        REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_templates_tenant_idx ON form_templates (tenant_id);
CREATE INDEX IF NOT EXISTS form_templates_status_idx ON form_templates (tenant_id, status);

CREATE TABLE IF NOT EXISTS form_instances (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id             UUID        NOT NULL REFERENCES form_templates(id),
  template_version        INTEGER     NOT NULL,
  document_id             UUID        REFERENCES documents(id) ON DELETE SET NULL,
  data_json               JSONB       NOT NULL DEFAULT '{}',
  generated_pdf_object_key TEXT,
  created_by              UUID        REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_instances_template_idx ON form_instances (template_id);
CREATE INDEX IF NOT EXISTS form_instances_document_idx ON form_instances (document_id);
