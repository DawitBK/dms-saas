-- CAMS: scanned/uploaded letters as a first-class origin, for BOTH directions.
--
-- Until now only INCOMING letters could carry an uploaded scan (registered
-- straight to a final state, no review), and OUTGOING letters could only be
-- composed in-system (rendered to PDF at approval). A letter that was typed
-- and signed on paper, then scanned, had no representation as an OUTGOING
-- letter — every outgoing record had to originate as a system compose.
--
-- origin_type tracks how the letter's content originated:
--   COMPOSED — written in the system, rendered to PDF at approval (existing
--              outgoing behavior, unchanged).
--   SCANNED  — the substantive content is an uploaded file (PDF/image/Word).
--              For OUTGOING+SCANNED, the file is staged in attachment_document_id
--              at creation (so reviewers can see what they're approving) and
--              promoted to document_id at final approval, mirroring COMPOSED's
--              invariant that document_id is only set once finalized.
--
-- cover_sheet_document_id: a QR can't be baked into an externally-produced
-- file the way it's stamped onto a system-rendered PDF, so SCANNED-origin
-- letters get a separate one-page generated cover sheet (reference number +
-- QR verification code) filed alongside the original attachment.
ALTER TABLE letters ADD COLUMN IF NOT EXISTS origin_type TEXT CHECK (origin_type IN ('COMPOSED', 'SCANNED'));
ALTER TABLE letters ADD COLUMN IF NOT EXISTS attachment_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE letters ADD COLUMN IF NOT EXISTS cover_sheet_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

-- Backfill existing rows so origin_type reflects how they actually originated.
-- Incoming letters registered with no scan (documentId null, "logged only")
-- are left NULL — they're neither composed nor scanned, just a paper record.
UPDATE letters SET origin_type = 'COMPOSED' WHERE direction = 'OUTGOING' AND origin_type IS NULL;
UPDATE letters SET origin_type = 'SCANNED' WHERE direction = 'INCOMING' AND document_id IS NOT NULL AND origin_type IS NULL;

CREATE INDEX IF NOT EXISTS letters_attachment_document_idx ON letters (attachment_document_id) WHERE attachment_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS letters_cover_sheet_document_idx ON letters (cover_sheet_document_id) WHERE cover_sheet_document_id IS NOT NULL;
