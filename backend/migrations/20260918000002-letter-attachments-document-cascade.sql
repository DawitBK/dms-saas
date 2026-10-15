-- DATA-5 (minor): letter_attachments.document_id was the one outlier with no
-- explicit ON DELETE clause (defaults to RESTRICT/NO ACTION) where every
-- structurally identical junction table (document_bundle_items.document_id,
-- document_comments.document_id, esigning's signature_requests.document_id,
-- etc.) is explicit ON DELETE CASCADE. Low risk in the normal flow —
-- removeLetterAttachment (letters.service.ts) already deletes the
-- LetterAttachment row before the Document row in the same transaction — but
-- trashService.ts's executePurge never touches letter_attachments at all, so
-- purging a letter-attachment's backing document through the ordinary
-- trash/purge pipeline (rather than through removeLetterAttachment) would hit
-- a raw, unhandled FK violation instead of either cascading cleanly or
-- failing with a clear application-level error.
ALTER TABLE letter_attachments DROP CONSTRAINT IF EXISTS letter_attachments_document_id_fkey;
ALTER TABLE letter_attachments
  ADD CONSTRAINT letter_attachments_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
