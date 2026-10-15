-- AI usage controls (brief item 5.12).
--
-- 1. tenants.ai_policy: the tenant's own AI rules (which AI features are on,
--    the most confidential document class that may leave the building, blocked
--    document types / departments, per-user and per-tenant daily limits, and
--    whether uploads are summarised automatically). Empty {} means "defaults",
--    which are enforced in code (modules/ai/aiPolicy.service.ts) so a tenant
--    that never opens the screen behaves exactly as documented.
--
-- 2. ai_usage_events: an append-only ledger of every AI request, allowed or
--    refused, with who asked, what for and how many tokens it cost. It is what
--    the daily limits count and what the "AI Controls" screen shows. It is not
--    the audit chain (that stays authoritative for who-did-what); it is a
--    cheap, queryable meter.
--
-- RLS follows the series in 20260710000001: tenant_id column match, with the
-- unset-GUC escape valve for workers and scripts.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          VARCHAR(100) NOT NULL,
  user_id            UUID NULL,
  feature            VARCHAR(30)  NOT NULL,  -- chat | summarize | extract | form_extraction
  trigger            VARCHAR(10)  NOT NULL DEFAULT 'user', -- user | auto (upload pipeline)
  document_id        UUID NULL,
  outcome            VARCHAR(40)  NOT NULL,  -- allowed | completed | failed | denied_*
  reason             TEXT NULL,
  input_tokens       INTEGER NULL,
  output_tokens      INTEGER NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_events_tenant_day_idx
  ON ai_usage_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_day_idx
  ON ai_usage_events (tenant_id, user_id, created_at DESC);

ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_events_tenant_isolation ON ai_usage_events;
CREATE POLICY ai_usage_events_tenant_isolation ON ai_usage_events
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

-- Same end state as every other tenant table (20260822000004): the table owner
-- must not bypass the policy.
ALTER TABLE ai_usage_events FORCE ROW LEVEL SECURITY;
