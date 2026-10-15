-- Reverts 20260625000001-add-audit-sequence-unique.sql. Drops the uniqueness
-- constraint on audit_logs.sequence_number and relaxes the column back to
-- nullable. Purely structural — no rows are removed or altered, so no audit
-- data is lost. The up migration's pre-check (raising an exception if
-- duplicate/NULL sequence numbers existed) has no schema effect and needs no
-- inverse.
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_sequence_number_unique;

ALTER TABLE audit_logs
  ALTER COLUMN sequence_number DROP NOT NULL;
