-- Reverts 20260625000002-add-document-date.sql. Safe: purely additive
-- (nullable column, index) — nothing else depends on it existing at the
-- database level. Any document_date values recorded are lost, which is
-- expected since the app code that reads this column is also being rolled
-- back.
DROP INDEX IF EXISTS documents_document_date_idx;
ALTER TABLE documents DROP COLUMN IF EXISTS document_date;
