-- S6-06 (Phase 6 "RLS done right"): extend row-level security to CAMS
-- (correspondence) tables, matching the pattern in
-- 20260615000002-rls-policies.sql minus the `current_user = 'postgres'`
-- bypass (see 20260703000008-rls-app-role.sql for why that bypass was
-- pointless and 20260703000009-rls-drop-postgres-bypass.sql for its removal
-- from the original 6 policies).
--
-- Same caveat applies here as everywhere else in this RLS work: this is
-- inert until the app's DB connection runs as a non-superuser role (e.g.
-- `edams_app`) in whatever environment wants enforcement — today's DB_USER
-- (`postgres`) is a superuser and bypasses RLS unconditionally.

-- ─── Tables with a direct tenant_id column ───────────────────────────────────

ALTER TABLE org_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE letter_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE letter_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_units_tenant_isolation ON org_units;
CREATE POLICY org_units_tenant_isolation ON org_units
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

DROP POLICY IF EXISTS letters_tenant_isolation ON letters;
CREATE POLICY letters_tenant_isolation ON letters
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

DROP POLICY IF EXISTS letter_links_tenant_isolation ON letter_links;
CREATE POLICY letter_links_tenant_isolation ON letter_links
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

DROP POLICY IF EXISTS letter_sequences_tenant_isolation ON letter_sequences;
CREATE POLICY letter_sequences_tenant_isolation ON letter_sequences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- ─── Tables scoped only via their parent letter (no tenant_id column) ───────
-- letter_revisions / letter_approval_steps / letter_dispatches carry only
-- letter_id — isolate them by checking the owning letters row's tenant_id.

ALTER TABLE letter_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE letter_approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE letter_dispatches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS letter_revisions_tenant_isolation ON letter_revisions;
CREATE POLICY letter_revisions_tenant_isolation ON letter_revisions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM letters l
      WHERE l.id = letter_revisions.letter_id
        AND l.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

DROP POLICY IF EXISTS letter_approval_steps_tenant_isolation ON letter_approval_steps;
CREATE POLICY letter_approval_steps_tenant_isolation ON letter_approval_steps
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM letters l
      WHERE l.id = letter_approval_steps.letter_id
        AND l.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

DROP POLICY IF EXISTS letter_dispatches_tenant_isolation ON letter_dispatches;
CREATE POLICY letter_dispatches_tenant_isolation ON letter_dispatches
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    EXISTS (
      SELECT 1 FROM letters l
      WHERE l.id = letter_dispatches.letter_id
        AND l.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- DROP POLICY IF EXISTS org_units_tenant_isolation ON org_units;
-- DROP POLICY IF EXISTS letters_tenant_isolation ON letters;
-- DROP POLICY IF EXISTS letter_links_tenant_isolation ON letter_links;
-- DROP POLICY IF EXISTS letter_sequences_tenant_isolation ON letter_sequences;
-- DROP POLICY IF EXISTS letter_revisions_tenant_isolation ON letter_revisions;
-- DROP POLICY IF EXISTS letter_approval_steps_tenant_isolation ON letter_approval_steps;
-- DROP POLICY IF EXISTS letter_dispatches_tenant_isolation ON letter_dispatches;
-- ALTER TABLE org_units DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE letters DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE letter_links DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE letter_sequences DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE letter_revisions DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE letter_approval_steps DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE letter_dispatches DISABLE ROW LEVEL SECURITY;
