-- Reverts 20260713000001-scanned-letters.sql. Safe: these columns/indexes
-- were purely additive (nullable columns, partial indexes) — nothing else
-- depends on them existing at the database level. Any letters rows that used
-- SCANNED origin lose that distinction on the way back down, which is
-- expected for a rollback (the app code being rolled back to never read
-- these columns anyway).
DROP INDEX IF EXISTS letters_cover_sheet_document_idx;
DROP INDEX IF EXISTS letters_attachment_document_idx;
ALTER TABLE letters DROP COLUMN IF EXISTS cover_sheet_document_id;
ALTER TABLE letters DROP COLUMN IF EXISTS attachment_document_id;
ALTER TABLE letters DROP COLUMN IF EXISTS origin_type;
