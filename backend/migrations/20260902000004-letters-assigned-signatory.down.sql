ALTER TABLE letters
  DROP COLUMN IF EXISTS assigned_signatory_user_id,
  DROP COLUMN IF EXISTS assigned_signatory_role;
