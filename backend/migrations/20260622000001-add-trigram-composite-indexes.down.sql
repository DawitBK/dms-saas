-- Reverts 20260622000001-add-trigram-composite-indexes.sql. Purely additive
-- indexes on pre-existing tables/columns — dropping them only affects query
-- planning and search performance, no data loss.
--
-- The pg_trgm extension itself is intentionally left installed:
-- 20260703000003-letters-indexes.sql also creates trigram indexes using it,
-- so dropping the extension here would break that later migration's objects.
DROP INDEX IF EXISTS idx_document_metadata_tags_trgm;
DROP INDEX IF EXISTS idx_document_metadata_description_trgm;
DROP INDEX IF EXISTS idx_document_metadata_keywords_trgm;
DROP INDEX IF EXISTS idx_documents_document_name_trgm;
DROP INDEX IF EXISTS idx_documents_title_trgm;
DROP INDEX IF EXISTS idx_documents_tenant_deleted_updated;
