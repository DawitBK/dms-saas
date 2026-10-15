-- Sprint 4 models migration
-- Run after 20260611000002-folders-ltree.sql
-- Creates tables for encryption keys, purge workflow, and retention tracking

-- S4-03: Document data encryption keys (DEK)
CREATE TABLE IF NOT EXISTS document_deks (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "documentId"     UUID         NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  "encryptedDek"   TEXT         NOT NULL,
  "kekId"          VARCHAR(255) NOT NULL,
  algorithm        VARCHAR(50)  NOT NULL DEFAULT 'AES-256-GCM',
  "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- S4-03: Department key-encryption keys (KEK) tracking
CREATE TABLE IF NOT EXISTS dept_keys (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "departmentId"   UUID         NOT NULL UNIQUE REFERENCES departments(id) ON DELETE CASCADE,
  "tenantId"       UUID         NOT NULL,
  "kekReference"   VARCHAR(255) NOT NULL,
  "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "rotatedAt"      TIMESTAMPTZ,
  "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dept_keys_tenant_idx ON dept_keys (tenant_id);

-- S4-08: Purge pending (soft delete workflow)
CREATE TABLE IF NOT EXISTS purge_pending (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "documentId"     UUID         NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  "stagedAt"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "purgeAfter"     TIMESTAMPTZ  NOT NULL,
  "approvedById"   UUID         REFERENCES users(id),
  "approvedAt"     TIMESTAMPTZ,
  status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING','APPROVED','CANCELLED')),
  "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- R-07 (AUDIT-FINDINGS-2026-09-03.md): this file used to re-create
-- purge_pending_status_idx on (status) alone, but 20260610000000-baseline.sql
-- already creates that same index NAME on (status, purge_after). IF NOT EXISTS
-- made this statement a permanent no-op -- the live index has always been the
-- baseline (status, purge_after) one, and filename ordering guarantees it
-- always will be -- so the statement only read as if it did something. Removed
-- rather than renamed: (status, purge_after) already serves every query a bare
-- (status) index would, as its leading column. The (purge_after) index below is
-- NOT redundant with it (different leading column) and stays.
CREATE INDEX IF NOT EXISTS purge_pending_purge_after_idx ON purge_pending (purge_after);

-- S4-03: Retention policy application tracking
CREATE TABLE IF NOT EXISTS retention_applications (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "documentId"          UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  "policyId"            UUID        NOT NULL REFERENCES retention_policies(id),
  "triggeredAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "eligibleAt"          TIMESTAMPTZ NOT NULL,
  "notified90Days"      BOOLEAN     NOT NULL DEFAULT FALSE,
  "notified30Days"      BOOLEAN     NOT NULL DEFAULT FALSE,
  "disposalAuthorisedAt" TIMESTAMPTZ,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retention_app_document_idx ON retention_applications (document_id);
CREATE INDEX IF NOT EXISTS retention_app_eligible_idx ON retention_applications (eligible_at);
CREATE INDEX IF NOT EXISTS retention_app_policy_idx ON retention_applications (policy_id);

-- S4-11: Sensitivity labels column on documents
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS "sensitivityLabel" VARCHAR(20) DEFAULT 'Internal'
  CHECK ("sensitivityLabel" IN ('Public', 'Internal', 'Confidential', 'Restricted'));

-- S4-12: Document checkout/lock table
CREATE TABLE IF NOT EXISTS doc_locks (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "documentId"   UUID        NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  "lockedBy"     UUID        NOT NULL REFERENCES users(id),
  "lockedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expiresAt"    TIMESTAMPTZ NOT NULL,
  reason         TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS doc_locks_expires_idx ON doc_locks (expires_at);
