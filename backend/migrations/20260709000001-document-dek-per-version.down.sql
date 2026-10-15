-- Reverts 20260709000001-document-dek-per-version.sql's structural changes.
--
-- IRREVERSIBLE DATA LOSS, spelled out plainly: the up-migration permanently
-- DELETEd every document_deks row it could not assign a version_id to
-- (documents with no document_versions row at all to backfill from) — those
-- rows, and whatever key material they held, are gone; nothing here brings
-- them back. Dropping version_id below also discards the per-version key
-- mapping itself (which DEK belongs to which document_version), which is
-- likewise not recoverable from anything still in the database.
--
-- Restoring the ORIGINAL per-document UNIQUE(document_id) constraint at the
-- bottom will FAIL if this database now holds more than one document_deks
-- row for the same document_id — i.e. if more than one version has been
-- uploaded for some document since this migration ran, which is exactly the
-- case this migration exists to allow. That failure is expected and
-- correct: it means this rollback cannot be applied safely without a manual,
-- destructive decision (picking which version's key to keep per affected
-- document, permanently losing the ability to decrypt the others) that has
-- to be made by a human, not guessed at here.
DROP INDEX IF EXISTS document_deks_document_id_idx;
ALTER TABLE document_deks DROP CONSTRAINT IF EXISTS document_deks_version_id_key;
ALTER TABLE document_deks DROP COLUMN IF EXISTS version_id;
ALTER TABLE document_deks ADD CONSTRAINT document_deks_document_id_key UNIQUE (document_id);
