-- Phase 1 hotfix: audit_logs had no tenant column, so any AUDIT_READ user could
-- export every tenant's history. New writes stamp tenant_id (from the request
-- context); all audit read/export endpoints now filter by it. Pre-existing rows
-- stay NULL and are no longer visible through the tenant-scoped endpoints.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_seq_idx ON audit_logs (tenant_id, sequence_number DESC);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_doc_idx ON audit_logs (tenant_id, document_id) WHERE document_id IS NOT NULL;
