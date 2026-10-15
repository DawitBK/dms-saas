-- Reverts 20260709000003-doc-locks-unique-document-id.sql. Safe at the
-- database level: drops a single UNIQUE constraint, nothing else depends on
-- it. Reintroduces the race this migration fixed (two concurrent checkout
-- requests can once again both see "no lock" and both insert a doc_locks
-- row for the same document), which is expected for a rollback — the app
-- code relying on this constraint to make that race impossible is also
-- being rolled back with it.
ALTER TABLE doc_locks DROP CONSTRAINT IF EXISTS doc_locks_document_id_key;
