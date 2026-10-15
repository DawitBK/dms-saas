-- CAMS Phase 1: Digital Correspondence & Archive Management System — foundation
--
-- org_units:            HQ / branches / outlets / sister companies inside one tenant
--                       ("distributed creation, centralized visibility")
-- letters:              a correspondence record (outgoing or incoming), 1:1-linked to a
--                       documents row once a final PDF / scan exists
-- letter_sequences:     gap-free per-unit-per-type-per-year reference counters
-- letter_revisions:     pre-approval draft version history
-- letter_approval_steps: maker–checker–approver chain per letter
-- letter_links:         cross-reference index (reply threads, related letters)
-- letter_dispatches:    dispatch & delivery tracking (digital + physical channels)

CREATE TABLE IF NOT EXISTS org_units (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      VARCHAR(100) NOT NULL,
  code           VARCHAR(30) NOT NULL,
  name           TEXT        NOT NULL,
  unit_type      TEXT        NOT NULL CHECK (unit_type IN ('HQ', 'BRANCH', 'OUTLET', 'SISTER_COMPANY')),
  parent_unit_id UUID        REFERENCES org_units(id) ON DELETE SET NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS org_units_tenant_idx ON org_units (tenant_id);

-- Every existing tenant gets an HQ unit so CAMS is usable immediately.
INSERT INTO org_units (tenant_id, code, name, unit_type)
SELECT id, 'HQ', name || ' — Head Office', 'HQ' FROM tenants
ON CONFLICT (tenant_id, code) DO NOTHING;

CREATE TABLE IF NOT EXISTS letters (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           VARCHAR(100) NOT NULL,
  direction           TEXT        NOT NULL CHECK (direction IN ('OUTGOING', 'INCOMING')),
  status              TEXT        NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'DISPATCHED', 'RECEIVED', 'ARCHIVED', 'CANCELLED'
  )),
  -- Allocated ONLY at final approval (outgoing) or registration (incoming). Gap-free.
  reference_number    TEXT,
  org_unit_id         UUID        NOT NULL REFERENCES org_units(id),
  department_id       UUID        REFERENCES departments(id),
  letter_type         TEXT        NOT NULL DEFAULT 'OUT' CHECK (letter_type IN ('OUT', 'IN', 'MEMO', 'CIRC', 'CONT')),
  subject             TEXT        NOT NULL,
  body_html           TEXT,
  language            VARCHAR(10) NOT NULL DEFAULT 'en',
  confidentiality     TEXT        NOT NULL DEFAULT 'INTERNAL' CHECK (confidentiality IN (
    'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
  )),
  priority            TEXT        NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'HIGH', 'URGENT')),
  -- Other party: recipient for OUTGOING, sender for INCOMING
  correspondent       TEXT,
  correspondent_organization TEXT,
  -- Incoming registration / routing
  received_date       DATE,
  due_date            DATE,
  assigned_to_user_id UUID        REFERENCES users(id),
  -- Signatory (stamped from the approving user's profile at final approval)
  signatory_user_id   UUID        REFERENCES users(id),
  signatory_name      TEXT,
  signatory_title     TEXT,
  approved_at         TIMESTAMPTZ,
  -- Final artifact: generated PDF (outgoing) or uploaded scan (incoming)
  document_id         UUID        REFERENCES documents(id) ON DELETE SET NULL,
  document_hash       TEXT,       -- sha256 of the final PDF, used by QR verification
  qr_payload          TEXT,       -- verification URL encoded in the printed QR
  year                INTEGER,
  created_by          UUID        NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS letters_tenant_ref_uniq
  ON letters (tenant_id, reference_number) WHERE reference_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS letters_tenant_unit_idx ON letters (tenant_id, org_unit_id);
CREATE INDEX IF NOT EXISTS letters_tenant_dir_status_idx ON letters (tenant_id, direction, status);
CREATE INDEX IF NOT EXISTS letters_tenant_year_idx ON letters (tenant_id, year);
CREATE INDEX IF NOT EXISTS letters_document_idx ON letters (document_id) WHERE document_id IS NOT NULL;

-- Strictly incrementing, gap-free counter per unit + type + year.
-- Rows are locked with SELECT ... FOR UPDATE inside the approval transaction.
CREATE TABLE IF NOT EXISTS letter_sequences (
  tenant_id   VARCHAR(100) NOT NULL,
  org_unit_id UUID        NOT NULL REFERENCES org_units(id),
  letter_type TEXT        NOT NULL,
  year        INTEGER     NOT NULL,
  last_value  INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, org_unit_id, letter_type, year)
);

-- Pre-approval draft history (6.1.1: auto-save + version history for every edit)
CREATE TABLE IF NOT EXISTS letter_revisions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id   UUID        NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  revision_no INTEGER     NOT NULL,
  subject     TEXT        NOT NULL,
  body_html   TEXT,
  saved_by    UUID        REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (letter_id, revision_no)
);

-- Maker–checker–approver chain (6.1.2). Sequential: exactly one PENDING step at a time.
CREATE TABLE IF NOT EXISTS letter_approval_steps (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id        UUID        NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  step_order       INTEGER     NOT NULL,
  step_type        TEXT        NOT NULL CHECK (step_type IN ('REVIEW', 'APPROVE')),
  assigned_user_id UUID        REFERENCES users(id),
  assigned_role    TEXT,
  status           TEXT        NOT NULL DEFAULT 'WAITING' CHECK (status IN (
    'WAITING', 'PENDING', 'APPROVED', 'RETURNED', 'CANCELLED'
  )),
  comment          TEXT,
  decided_by       UUID        REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (letter_id, step_order),
  CHECK (assigned_user_id IS NOT NULL OR assigned_role IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS letter_steps_letter_idx ON letter_approval_steps (letter_id);
CREATE INDEX IF NOT EXISTS letter_steps_pending_idx ON letter_approval_steps (status) WHERE status = 'PENDING';

-- Cross-reference index (5.2): links related letters regardless of archive space
CREATE TABLE IF NOT EXISTS letter_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         VARCHAR(100) NOT NULL,
  letter_id         UUID        NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  related_letter_id UUID        NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  link_type         TEXT        NOT NULL DEFAULT 'RELATED' CHECK (link_type IN ('REPLY_TO', 'RELATED', 'FOLLOW_UP')),
  created_by        UUID        REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (letter_id, related_letter_id, link_type),
  CHECK (letter_id <> related_letter_id)
);

CREATE INDEX IF NOT EXISTS letter_links_related_idx ON letter_links (related_letter_id);

-- Dispatch & delivery tracking (6.1.6): digital and physical channels
CREATE TABLE IF NOT EXISTS letter_dispatches (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_id           UUID        NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  channel             TEXT        NOT NULL CHECK (channel IN (
    'EMAIL', 'PORTAL', 'PRINT', 'COURIER', 'HAND_DELIVERY', 'REGISTERED_MAIL'
  )),
  recipient_name      TEXT,
  recipient_address   TEXT,
  tracking_reference  TEXT,
  notes               TEXT,
  dispatched_by       UUID        REFERENCES users(id),
  dispatched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at     TIMESTAMPTZ,
  acknowledgment_note TEXT
);

CREATE INDEX IF NOT EXISTS letter_dispatches_letter_idx ON letter_dispatches (letter_id);
