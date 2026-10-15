-- Reverts 20260703000005-document-bundles.sql. Drops the bundle tables and
-- their indexes in reverse order of creation (document_bundle_items before
-- document_bundles, since the former references the latter). Any bundles and
-- bundle-item orderings recorded so far are lost, which is expected since
-- the app code being rolled back to never reads these tables.
--
-- The RET-BUNDLE-5Y retention policy and per-tenant BUNDLE document type
-- seeded at the top of the up migration are intentionally left in place:
-- they are reference/lookup rows that a compiled bundle's document row
-- (documents.document_type_id) may already reference by foreign key, so
-- deleting them here would risk an FK violation or cascading away real
-- compiled documents, with no reliable way to tell a still-unused seed row
-- from one genuinely in use.
DROP INDEX IF EXISTS document_bundle_items_document_idx;
DROP INDEX IF EXISTS document_bundle_items_bundle_idx;
DROP TABLE IF EXISTS document_bundle_items CASCADE;

DROP INDEX IF EXISTS document_bundles_compiled_document_idx;
DROP INDEX IF EXISTS document_bundles_tenant_idx;
DROP TABLE IF EXISTS document_bundles CASCADE;
