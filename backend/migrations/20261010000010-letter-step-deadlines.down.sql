-- Reverses 20261010000010. Deadline, breach and escalation history on letter steps is dropped with the columns.
DROP INDEX IF EXISTS letter_steps_overdue_idx;
ALTER TABLE letter_approval_steps DROP COLUMN IF EXISTS escalated_to_user_ids;
ALTER TABLE letter_approval_steps DROP COLUMN IF EXISTS escalated_at;
ALTER TABLE letter_approval_steps DROP COLUMN IF EXISTS sla_breached_at;
ALTER TABLE letter_approval_steps DROP COLUMN IF EXISTS due_at;
ALTER TABLE letter_approval_steps DROP COLUMN IF EXISTS sla_hours;
