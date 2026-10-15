-- Lets the drafter choose who signs a letter (by named person or by
-- department-scoped role) at submit time, instead of it always defaulting
-- to whoever completes the final APPROVE step (enterPendingSignatureInTx's
-- prior, and still-default, behavior — both columns NULL preserves it
-- exactly).
--
-- No CHECK constraint — same "exactly one" enforced at the Zod layer
-- (submitSchema's `signatory` field), not the DB, precedent as
-- letter_approval_steps and signature_recipients.assigned_role.
ALTER TABLE letters
  ADD COLUMN IF NOT EXISTS assigned_signatory_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS assigned_signatory_role TEXT;
