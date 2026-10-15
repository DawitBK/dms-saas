-- FIX: doc_locks had no uniqueness constraint on document_id, so the
-- check-then-create in lockDocument() (find existing lock, if none create
-- one) was a genuine race — two concurrent checkout requests for the same
-- document could both see "no lock" and both succeed, leaving two lock rows
-- for one document with getLockStatus/unlockDocument behaving
-- nondeterministically about which one they see.
ALTER TABLE doc_locks ADD CONSTRAINT doc_locks_document_id_key UNIQUE (document_id);
