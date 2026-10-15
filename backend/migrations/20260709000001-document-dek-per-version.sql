-- FIX: DocumentDek was keyed uniquely by document_id, so every new version's
-- DEK overwrote the previous one — making every prior version's ciphertext
-- (and any later rollback target) permanently undecryptable. DEKs must be
-- scoped per-version: each DocumentVersion's ciphertext is encrypted under
-- its own DEK, and that DEK must survive for as long as the ciphertext does.
--
-- Existing document_deks rows predate this fix and are only ever valid for
-- whichever version was most recently uploaded — there is no way to recover
-- the keys for already-overwritten versions, since the key material itself
-- was destroyed, not just unreferenced. This migration backfills version_id
-- with each document's current latest_version_id (the one version each
-- pre-existing DEK row can actually still decrypt) and drops the old
-- document-level uniqueness in favor of per-version uniqueness.
--
-- AUDIT-FINDINGS-2026-07-26.md #15: the ADD COLUMN/ADD CONSTRAINT below were
-- bare, unlike sibling migrations that guard DDL defensively — a partial
-- failure mid-migration (e.g. the process killed between ADD COLUMN and the
-- final ADD CONSTRAINT) left no clean re-run path, since a second run would
-- immediately fail on "column already exists". Guarded here so this file is
-- safely re-runnable after any partial failure.

ALTER TABLE document_deks ADD COLUMN IF NOT EXISTS version_id UUID REFERENCES document_versions(id);

UPDATE document_deks dek
SET version_id = d.latest_version_id
FROM documents d
WHERE d.id = dek.document_id AND dek.version_id IS NULL AND d.latest_version_id IS NOT NULL;

-- Fallback for rows whose document.latest_version_id was never populated —
-- legacy/seed data predating that field, or inserted by a path that bypassed
-- application code. Use that document's most recent document_versions row
-- instead; it's the same value application code would have written into
-- latest_version_id anyway.
UPDATE document_deks dek
SET version_id = sub.version_id
FROM (
  SELECT DISTINCT ON (document_id) document_id, id AS version_id
  FROM document_versions
  ORDER BY document_id, created_at DESC
) sub
WHERE sub.document_id = dek.document_id AND dek.version_id IS NULL;

-- Truly orphaned DEK rows (document has no version rows at all to backfill
-- from) can't be given a valid version_id — nothing to decrypt for them. Drop
-- them rather than let the NOT NULL constraint below fail the whole migration.
DELETE FROM document_deks WHERE version_id IS NULL;

ALTER TABLE document_deks DROP CONSTRAINT IF EXISTS document_deks_document_id_key;
-- SET NOT NULL on an already-NOT-NULL column is a no-op in Postgres (safe to re-run).
ALTER TABLE document_deks ALTER COLUMN version_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_deks_version_id_key'
  ) THEN
    ALTER TABLE document_deks ADD CONSTRAINT document_deks_version_id_key UNIQUE (version_id);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS document_deks_document_id_idx ON document_deks (document_id);
