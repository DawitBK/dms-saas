-- Reverts 20260703000004-letter-responded-status.sql, restoring the original
-- letters_status_check CHECK constraint from 20260702000001-cams-foundation.sql
-- (without RESPONDED/CLOSED).
--
-- Note: this will fail at ADD CONSTRAINT time if any letters row has already
-- transitioned to RESPONDED or CLOSED since this migration shipped, because
-- Postgres validates a new CHECK constraint against existing rows. That is
-- expected/unavoidable — there is no way to un-transition those rows without
-- guessing at what status they held before, so this rollback assumes it runs
-- before any letter actually reaches RESPONDED/CLOSED, or that such rows are
-- manually reset first.
ALTER TABLE letters DROP CONSTRAINT IF EXISTS letters_status_check;
ALTER TABLE letters ADD CONSTRAINT letters_status_check CHECK (status IN (
  'DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'DISPATCHED', 'RECEIVED', 'ARCHIVED', 'CANCELLED'
));
