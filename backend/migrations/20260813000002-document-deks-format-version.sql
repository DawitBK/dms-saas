-- Perf audit 2026-08-13: documentCrypto.ts's canonical layout is
-- IV(12) || AuthTag(16) || ciphertext, which puts the GCM auth tag BEFORE
-- the ciphertext it authenticates. That's fine for buffer-at-once
-- encrypt/decrypt (encryptAndStore/fetchAndDecrypt, unchanged, still used by
-- every existing caller) but incompatible with true streaming: the auth tag
-- is only computable by the cipher AFTER the entire plaintext has been
-- processed, so a streaming writer can't put it first.
--
-- The new streaming path (encryptStreamAndStore/fetchDecryptStream, used
-- only by tus uploads over 100MB) instead writes IV(12) || ciphertext ||
-- AuthTag(16) — tag at the end, so it can be appended once streaming
-- finishes. format_version distinguishes the two layouts per DocumentDek row
-- (keyed by versionId, same as the encryption key itself) so the reader
-- knows which framing to expect. Existing rows default to 1 (legacy
-- HEAD-tag layout, the only layout that has ever existed); new streaming
-- writes explicitly set 2 (TAIL-tag layout).
ALTER TABLE document_deks
  ADD COLUMN IF NOT EXISTS format_version SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN document_deks.format_version IS
  '1 = IV||AuthTag||ciphertext (buffered, legacy/default); 2 = IV||ciphertext||AuthTag (streaming)';
