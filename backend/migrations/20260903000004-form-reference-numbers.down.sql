-- Reverses 20260903000004-form-reference-numbers.sql.
--
-- DESTRUCTIVE: dropping reference_number discards numbers already allocated to
-- approved forms. Those numbers are printed on filed documents and referenced
-- by people, and the counter cannot regenerate them — re-running the up
-- migration starts every sequence from zero again. Only run this on an
-- environment where no form has been approved since the up migration, or where
-- losing the correspondence trail is acceptable.
DROP INDEX IF EXISTS form_instances_reference_number_key;

ALTER TABLE form_instances
  DROP COLUMN IF EXISTS reference_allocated_at,
  DROP COLUMN IF EXISTS reference_number;

DROP TABLE IF EXISTS form_sequences;
