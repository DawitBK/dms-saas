-- Reverts 20260628000002-add-department-id-to-document-types.sql. The
-- column was purely additive (nullable FK), so dropping it is safe;
-- department-scoping information on any document_types rows is lost on the
-- way back down, which is expected since the app code being rolled back to
-- never read this column anyway.
DROP INDEX IF EXISTS idx_document_types_department_id;
ALTER TABLE document_types DROP COLUMN IF EXISTS department_id;
