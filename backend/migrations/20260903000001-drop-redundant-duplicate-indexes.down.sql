-- Recreate the duplicates exactly as 20260615000010-perf-indexes.sql and
-- 20260627000000-access-rules.sql created them, so a down-migration restores
-- the previous schema byte-for-byte even though the indexes are redundant.
CREATE INDEX IF NOT EXISTS idx_audit_logs_document_id ON audit_logs(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_document_id ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_access_rules_principal ON access_rules(tenant_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, read_at);
