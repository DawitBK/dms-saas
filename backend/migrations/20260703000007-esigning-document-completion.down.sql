-- Reverts 20260703000007-esigning-document-completion.sql. Safe: a single
-- nullable column added on top of the e-signing tables from
-- 20260701000005-esigning.sql (which this migration does not otherwise touch).
-- Any fully_signed_at timestamps recorded so far are lost, which is expected
-- for a rollback (the app code being rolled back to never reads this column).
ALTER TABLE documents DROP COLUMN IF EXISTS fully_signed_at;
