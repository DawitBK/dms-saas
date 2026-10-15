-- Phase 8: E-signing
--
-- signature_requests: envelope for a signing flow on a document.
-- signature_recipients: one row per person who must sign (EDAMS user or external).
-- signature_fields: field placement on the PDF (page, coords, dimensions, type).

CREATE TABLE IF NOT EXISTS signature_requests (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id              UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- source = 'freeform' (sender placed fields manually) | 'form_instance' (fields from B1)
  source                   TEXT        NOT NULL DEFAULT 'freeform' CHECK (source IN ('freeform', 'form_instance')),
  ordering_mode            TEXT        NOT NULL DEFAULT 'parallel' CHECK (ordering_mode IN ('parallel', 'serial')),
  status                   TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'sent', 'partially_signed', 'completed', 'voided', 'expired'
  )),
  -- On completion: optionally move document to a folder and/or notify
  completion_action        TEXT        NOT NULL DEFAULT 'none' CHECK (completion_action IN ('none', 'move_folder', 'notify_only')),
  completion_target_folder_id UUID     REFERENCES folder_nodes(id) ON DELETE SET NULL,
  voided_reason            TEXT,
  expires_at               TIMESTAMPTZ,
  created_by               UUID        REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sig_req_doc_idx ON signature_requests (document_id);
CREATE INDEX IF NOT EXISTS sig_req_status_idx ON signature_requests (status);

CREATE TABLE IF NOT EXISTS signature_recipients (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_request_id UUID       NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  -- order_index for serial signing (all sign simultaneously when ordering_mode='parallel')
  order_index         INTEGER     NOT NULL DEFAULT 0,
  name                TEXT        NOT NULL,
  email               TEXT        NOT NULL,
  -- null = external signer (authenticated by access_token); set = EDAMS user
  edams_user_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'viewed', 'signed', 'declined'
  )),
  signed_at           TIMESTAMPTZ,
  declined_at         TIMESTAMPTZ,
  decline_reason      TEXT,
  ip_address          TEXT,
  -- scoped bearer token for external signers (emailed link)
  access_token        TEXT        UNIQUE,
  access_token_expires TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sig_rec_req_idx ON signature_recipients (signature_request_id);
CREATE INDEX IF NOT EXISTS sig_rec_token_idx ON signature_recipients (access_token) WHERE access_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS signature_fields (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_request_id UUID        NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  recipient_id         UUID        NOT NULL REFERENCES signature_recipients(id) ON DELETE CASCADE,
  page_number          INTEGER     NOT NULL DEFAULT 1,
  -- Coordinates in PDF point-space (72pt = 1 inch)
  x                    FLOAT       NOT NULL,
  y                    FLOAT       NOT NULL,
  width                FLOAT       NOT NULL,
  height               FLOAT       NOT NULL,
  field_type           TEXT        NOT NULL DEFAULT 'signature' CHECK (field_type IN (
    'signature', 'initial', 'date', 'text', 'seal'
  )),
  -- Captured value after signing (signature = base64 image or PAdES blob)
  value                TEXT,
  signed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sig_field_req_idx ON signature_fields (signature_request_id);
