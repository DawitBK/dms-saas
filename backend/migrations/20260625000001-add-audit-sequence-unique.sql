-- Ensure the HMAC audit chain has a single, gapless sequence source.
-- Existing duplicate sequence numbers must be remediated before this can apply.

DO $$
DECLARE
  duplicate_sequences TEXT;
BEGIN
  SELECT string_agg(sequence_number::text || ' (' || count || ')', ', ' ORDER BY sequence_number)
  INTO duplicate_sequences
  FROM (
    SELECT sequence_number, COUNT(*) AS count
    FROM audit_logs
    WHERE sequence_number IS NOT NULL
    GROUP BY sequence_number
    HAVING COUNT(*) > 1
  ) dupes;

  IF duplicate_sequences IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add audit_logs.sequence_number unique constraint; duplicate sequence numbers exist: %',
      duplicate_sequences;
  END IF;

  IF EXISTS (SELECT 1 FROM audit_logs WHERE sequence_number IS NULL) THEN
    RAISE EXCEPTION 'Cannot add audit_logs.sequence_number unique constraint; NULL sequence numbers exist';
  END IF;
END $$;

ALTER TABLE audit_logs
  ALTER COLUMN sequence_number SET NOT NULL;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_sequence_number_unique UNIQUE (sequence_number);
