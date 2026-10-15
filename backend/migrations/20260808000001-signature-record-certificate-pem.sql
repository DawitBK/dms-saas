-- Retain the signer certificate alongside new PKI signatures so verification
-- can prove the key that created the signature. Existing records remain
-- explicitly unverifiable because their key material was never stored.
ALTER TABLE signature_records
  ADD COLUMN IF NOT EXISTS certificate_pem TEXT;
