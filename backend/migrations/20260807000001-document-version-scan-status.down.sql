DROP INDEX IF EXISTS document_versions_unscanned_idx;
ALTER TABLE document_versions DROP COLUMN IF EXISTS av_scan_status;
