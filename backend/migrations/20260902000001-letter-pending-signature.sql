-- Real e-signing for outgoing composed letters: the final approval step now
-- routes the letter through an actual signature ceremony
-- (modules/esigning/) instead of stamping a fake "Approved and digitally
-- signed by" text block. PENDING_SIGNATURE sits between IN_REVIEW and
-- APPROVED for that path — see enterPendingSignatureInTx /
-- finalizeLetterAfterSigning in letters.service.ts and the updated
-- LetterStateMachine.ts transition table.
--
-- signed_draft_document_id keeps a permanent link to the unnumbered
-- signable-draft document (letters.document_id points at it only
-- transiently, while PENDING_SIGNATURE, then gets overwritten with the
-- final numbered document once signing completes and the letter is
-- finalized) — this is the durable cryptographic proof that the approver
-- actually signed the letter's content, kept around after document_id moves
-- on. Same soft-reference style as attachment_document_id/
-- cover_sheet_document_id (20260713000001-scanned-letters.sql).

ALTER TABLE letters ADD COLUMN IF NOT EXISTS signed_draft_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS letters_signed_draft_document_idx ON letters (signed_draft_document_id) WHERE signed_draft_document_id IS NOT NULL;

ALTER TABLE letters DROP CONSTRAINT IF EXISTS letters_status_check;
ALTER TABLE letters ADD CONSTRAINT letters_status_check CHECK (status IN (
  'DRAFT', 'IN_REVIEW', 'RETURNED', 'PENDING_SIGNATURE', 'APPROVED', 'DISPATCHED',
  'RECEIVED', 'RESPONDED', 'CLOSED', 'ARCHIVED', 'CANCELLED'
));
