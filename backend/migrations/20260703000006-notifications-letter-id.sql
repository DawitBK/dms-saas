-- CAMS letter notifications (LETTER_STEP_PENDING / LETTER_REGISTERED /
-- LETTER_APPROVED / LETTER_RETURNED) need a way to deep-link the in-app
-- notification back to the letter that triggered it, the same way document_id
-- already does for document-related notification types.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS letter_id UUID;
CREATE INDEX IF NOT EXISTS notifications_letter_idx ON notifications(letter_id);
