-- Reverts 20260615000010-perf-indexes.sql. Purely additive performance
-- indexes on pre-existing tables — safe to drop in any order since nothing
-- else depends on these specific index names existing. Only affects query
-- planning; no data loss.
DROP INDEX IF EXISTS idx_document_versions_created_at;
DROP INDEX IF EXISTS idx_document_versions_document_id;
DROP INDEX IF EXISTS idx_notifications_created_at;
DROP INDEX IF EXISTS idx_notifications_user_id;
DROP INDEX IF EXISTS idx_audit_logs_document_id;
DROP INDEX IF EXISTS idx_audit_logs_timestamp;
DROP INDEX IF EXISTS idx_documents_updated_at;
DROP INDEX IF EXISTS idx_documents_deleted_at;
DROP INDEX IF EXISTS idx_documents_owner_id;
DROP INDEX IF EXISTS idx_documents_department_id;
DROP INDEX IF EXISTS idx_documents_folder_id;
DROP INDEX IF EXISTS idx_documents_status;
