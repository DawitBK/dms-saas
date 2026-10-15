-- Reverts 20261004000021. NOTE: hashed tokens cannot be turned back into plaintext, so after a down-migration
-- every still-pending external signer's emailed link stops working (the old code compares plaintext, and the
-- plaintext was cleared). The requester must Remind (re-send) such requests. Redacted outbox payloads stay redacted.
DROP INDEX IF EXISTS sig_rec_token_hash_uidx;
ALTER TABLE signature_recipients DROP COLUMN IF EXISTS access_token_hash;
ALTER TABLE signature_requests DROP COLUMN IF EXISTS signed_version_id;
ALTER TABLE signature_requests DROP COLUMN IF EXISTS document_version_id;
