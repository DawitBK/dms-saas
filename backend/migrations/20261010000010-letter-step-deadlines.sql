-- Letter approval steps get a deadline, a breach flag and an escalation, the same shape as the unified
-- engine's approval_steps (sla_hours, due_at, sla_breached_at, escalated_at, escalated_to_user_ids).
-- Until now a letter step had no clock at all: a step waiting on someone on leave sat PENDING until a head
-- noticed. All columns are additive and nullable (or default empty), so every existing letter keeps behaving
-- exactly as before; a step only gets a deadline when the drafter sets one at submit time or the tenant sets
-- LETTER_STEP_DEFAULT_SLA_HOURS. The partial index keeps the 15-minute sweep cheap.
ALTER TABLE letter_approval_steps ADD COLUMN IF NOT EXISTS sla_hours integer;
ALTER TABLE letter_approval_steps ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE letter_approval_steps ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz;
ALTER TABLE letter_approval_steps ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE letter_approval_steps ADD COLUMN IF NOT EXISTS escalated_to_user_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS letter_steps_overdue_idx
  ON letter_approval_steps (due_at) WHERE status = 'PENDING' AND due_at IS NOT NULL;
