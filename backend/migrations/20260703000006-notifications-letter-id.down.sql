-- Reverts 20260703000006-notifications-letter-id.sql. Safe: a nullable
-- column plus its index, purely additive — nothing else depends on it
-- existing at the database level. Any letter_id links recorded on
-- notifications so far are lost, which is expected since the app code being
-- rolled back to never reads this column (CAMS letter notifications simply
-- go back to not deep-linking to their letter).
DROP INDEX IF EXISTS notifications_letter_idx;
ALTER TABLE notifications DROP COLUMN IF EXISTS letter_id;
