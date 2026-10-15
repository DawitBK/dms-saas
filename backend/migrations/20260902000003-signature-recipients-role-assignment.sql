-- Adds role-based signer assignment to e-signing recipients, alongside the
-- existing named-user (edams_user_id) and external (name/email) modes.
--
-- No CHECK constraint, deliberately — mirrors letter_approval_steps'
-- existing precedent of enforcing "exactly one assignment mode" at the
-- service/Zod layer, not the DB: a claimed role-based recipient legitimately
-- ends up with BOTH edams_user_id and assigned_role set (esigning.service.ts's
-- signDocument stamps the claiming user's identity onto an unclaimed
-- role-based recipient the moment they sign, keeping assigned_role as a
-- historical record of how the slot was originally assigned).
ALTER TABLE signature_recipients
  ADD COLUMN IF NOT EXISTS assigned_role TEXT;
