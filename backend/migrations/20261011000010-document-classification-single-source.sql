-- A document's class had two answers in the database.
--
-- documents.security_classification (PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED, upper case) is the class the product uses: the upload form, the
-- classification control, the search filter, the access rule in shared/classifiedAccess.ts. documents."sensitivityLabel" (Public | Internal | Confidential |
-- Restricted, title case) is an older second column for the same fact. Nothing in the interface shows it, nothing chose it independently, and it was only ever
-- written with a default of 'Internal' next to whatever class the person picked: on the development database ten documents are CONFIDENTIAL, PUBLIC or RESTRICTED
-- and carry the label 'Internal'. Two answers to one question is the gap this migration closes, in the database itself so that it holds whichever code path
-- writes the row (upload, resumable upload, forms, letters, e-signing, bundles, a script, a person at a SQL prompt):
--
--   1. security_classification gets the CHECK it never had (the label column already had one), so only the four classes can be stored.
--   2. A trigger sets "sensitivityLabel" from the class on every insert and update. The label can no longer be written independently or disagree.
--   3. Existing rows are brought into line first (only the label changes; the class, which is what access follows, is never touched).
--
-- The search service still treats a document as Restricted if EITHER field says so (a belt-and-braces rule from when they could differ); that stays and is now
-- simply redundant. The application no longer accepts a label from the caller (modules/documents), so the API says one thing too.
--
-- SAFE: step 3 changes one metadata column on rows whose class is valid. The class CHECK is added NOT VALID (enforced for every new and changed row at once) and then
-- validated; if an old row holds some other class, the constraint stays NOT VALID with a notice and that row can be corrected at leisure. The development and
-- mirror databases hold only valid classes. Reversible (the .down file drops the trigger, function and constraint; the repaired labels stay repaired).

UPDATE documents
   SET "sensitivityLabel" = initcap(lower(security_classification))
 WHERE security_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')
   AND "sensitivityLabel" IS DISTINCT FROM initcap(lower(security_classification));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_security_classification_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_security_classification_check
      CHECK (security_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE documents VALIDATE CONSTRAINT documents_security_classification_check;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'documents_security_classification_check left NOT VALID: some existing rows hold another class (new and changed rows are still checked)';
END $$;

CREATE OR REPLACE FUNCTION documents_sync_sensitivity_label() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only for the four real classes: a row holding anything else is left as it is (the class CHECK deals with it), so this trigger can never be the thing that stops an update.
  IF NEW.security_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED') THEN
    NEW."sensitivityLabel" := initcap(lower(NEW.security_classification));
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS documents_sync_sensitivity_label ON documents;
CREATE TRIGGER documents_sync_sensitivity_label
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_sync_sensitivity_label();
