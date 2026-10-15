-- Reverts 20260902000001-letter-pending-signature.sql.
--
-- Note: like 20260703000004-letter-responded-status.down.sql, the CHECK
-- constraint restore below will fail at ADD CONSTRAINT time if any letters
-- row is currently PENDING_SIGNATURE, since Postgres validates a new CHECK
-- against existing rows. Expected/unavoidable — resolve any pending
-- ceremonies (or manually reset those rows) before rolling back.
ALTER TABLE letters DROP CONSTRAINT IF EXISTS letters_status_check;
ALTER TABLE letters ADD CONSTRAINT letters_status_check CHECK (status IN (
  'DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'DISPATCHED',
  'RECEIVED', 'RESPONDED', 'CLOSED', 'ARCHIVED', 'CANCELLED'
));

DROP INDEX IF EXISTS letters_signed_draft_document_idx;
ALTER TABLE letters DROP COLUMN IF EXISTS signed_draft_document_id;
