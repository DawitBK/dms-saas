-- E-signing audit E23 + E24.
--
-- E23: a signature request did not pin the document version. The signer signed (and the signed copy was
-- flattened from) whatever the document's LATEST version was at that moment, while the fields had been placed
-- on an earlier one. signature_requests.document_version_id pins the version the fields were placed on;
-- sign / view / flatten now use it and refuse when a newer version exists. signed_version_id records the
-- version holding the filed signed copy (also makes the "already filed" check per request instead of per document).
--
-- E24: external-signer access tokens were stored in plaintext. access_token_hash holds SHA-256(token) (hex);
-- the plaintext column stays (nullable, now always NULL) so a rolling deploy does not break, and is cleared here.
--
-- Existing pending tokens: each plaintext token is hashed IN PLACE and the plaintext cleared, so links that were
-- already emailed keep working until their own expiry (no re-issue needed). Delivered outbox rows that still
-- carry the raw link are redacted; rows not yet delivered are left alone (their link is the one just migrated).
--
-- Live requests are pinned to the document's current latest version (= what they were already going to sign).
-- Completed / voided / expired requests stay NULL (historical; the service treats NULL as the old behaviour).
--
-- SAFE: additive nullable columns, idempotent updates, no row removed.
ALTER TABLE signature_requests
  ADD COLUMN IF NOT EXISTS document_version_id UUID REFERENCES document_versions(id) ON DELETE SET NULL;
ALTER TABLE signature_requests
  ADD COLUMN IF NOT EXISTS signed_version_id UUID REFERENCES document_versions(id) ON DELETE SET NULL;

UPDATE signature_requests sr
   SET document_version_id = d.latest_version_id
  FROM documents d
 WHERE d.id = sr.document_id
   AND sr.document_version_id IS NULL
   AND d.latest_version_id IS NOT NULL
   AND sr.status IN ('draft', 'sent', 'partially_signed');

ALTER TABLE signature_recipients ADD COLUMN IF NOT EXISTS access_token_hash TEXT;

UPDATE signature_recipients
   SET access_token_hash = encode(sha256(convert_to(access_token, 'UTF8')), 'hex')
 WHERE access_token IS NOT NULL
   AND access_token_hash IS NULL;

UPDATE signature_recipients SET access_token = NULL WHERE access_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sig_rec_token_hash_uidx
  ON signature_recipients (access_token_hash) WHERE access_token_hash IS NOT NULL;

-- Redact the raw link from outbox rows that have already been delivered (or given up on).
UPDATE outbox_events
   SET payload = regexp_replace(
         regexp_replace(payload, '"accessToken"\s*:\s*("[^"]*"|null)\s*,?', '', 'g'),
         '([?&]token=)[A-Za-z0-9_%.~-]+', '\1REDACTED', 'g')
 WHERE type = 'ESIGNING.RECIPIENT_INVITED'
   AND status IN ('PROCESSED', 'DEAD_LETTER')
   AND (payload LIKE '%accessToken%' OR payload LIKE '%token=%');
