-- Platform audit finding (2026-08-14, DMS full audit): legal_holds had NO
-- tenant_id column at all, and legal-hold.service.ts's getLegalHolds()/
-- getLegalHold()/applyHoldToDocuments() had no tenant filter — any user in
-- ANY tenant holding LEGAL_HOLD_READ could list every other tenant's legal
-- holds (case references, custodian names, affected document names), and
-- LEGAL_HOLD_MANAGE holders could place a hold on another tenant's documents
-- via /:id/add-documents. A legal hold is tenant-specific data (unlike
-- retention policies, which are genuinely a shared, platform-wide config) —
-- give it the same tenant scoping every other tenant-owned table has.

-- Tenant ids are slug strings (e.g. "examplecorp"), not UUIDs — see CLAUDE.md's
-- gotcha; matches documents.tenant_id's actual type (varchar(100)).
ALTER TABLE legal_holds ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(100) REFERENCES tenants(id);

-- Backfill from the tenant of any document the hold has ever been applied
-- to (a hold's tenant is fixed at creation and every document it ever holds
-- must belong to that same tenant, so any one is a valid source).
UPDATE legal_holds lh
SET tenant_id = (
  SELECT d.tenant_id
  FROM document_legal_holds dlh
  JOIN documents d ON d.id = dlh.document_id
  WHERE dlh.legal_hold_id = lh.id
  LIMIT 1
)
WHERE lh.tenant_id IS NULL;

-- Rare edge case: a hold created with no documentIds and never given any
-- since (createLegalHold's documentIds param is optional). Nothing to infer
-- from, so fall back to the oldest tenant — same fallback shape
-- 20260704000002-department-org-unit.sql already uses for departments with
-- no org unit. Flag these for manual review; there should be none in
-- practice since this table is brand new (SPRINT-5) and barely used.
UPDATE legal_holds
SET tenant_id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1)
WHERE tenant_id IS NULL;

ALTER TABLE legal_holds ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS legal_holds_tenant_idx ON legal_holds (tenant_id);

-- SAFE: the SET NOT NULL above is preceded, in this same file, by the two
-- backfill UPDATEs that guarantee no NULL remains — the "already backfilled"
-- case check-migration-safety.ts asks to have acknowledged. Old app code also
-- survives it: nothing wrote legal_holds rows without a tenant before this
-- migration because the column did not exist, and legal-hold.service.ts's
-- createLegalHold sets it from the caller's tenant from this migration
-- onwards.
