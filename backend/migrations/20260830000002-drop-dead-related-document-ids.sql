-- related_document_ids (document_metadata) was write-only: written once by
-- bundles.service.ts as a comma-joined string, never read anywhere in the
-- backend or frontend. The real bundle-membership relation is already
-- properly modeled via the document_bundle_items join table. Dropping the
-- dead column and its write site.
ALTER TABLE document_metadata
  DROP COLUMN IF EXISTS related_document_ids;

-- SAFE: the DROP COLUMN above is safe for old app code specifically because
-- the column was write-only — greppably so: bundles.service.ts was the sole
-- writer and there was no reader anywhere in backend or frontend, and that
-- write site was removed in the same commit as this migration. Bundle
-- membership is, and already was, carried by the document_bundle_items join
-- table, so no behaviour depends on this column in either the old or the new
-- code.
