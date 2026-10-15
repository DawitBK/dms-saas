-- Follow-up to 20260814000001-legal-holds-tenant-id.sql: that migration added
-- legal_holds.tenant_id (NOT NULL, backfilled) so the application layer
-- could scope every query in legal-hold.service.ts. But per this codebase's
-- established RLS series (20260710000001-rls-remaining-tenant-tables.sql,
-- 20260718000001-outbox-tenant-id-rls.sql, etc.), a tenant-owned table is
-- meant to get a database-level backstop too, not rely on application code
-- alone — that's the whole point of defense-in-depth: a future regression of
-- exactly the bug 20260814000001 just fixed (a forgotten tenantId filter)
-- would otherwise have zero backstop on this one table, unlike every other
-- tenant-owned table in the schema. legal_holds was never part of that RLS
-- series because it had no tenant_id column at the time.
--
-- Same shape as acl_entries/access_rules (20260710000001): tenant_id is
-- NOT NULL here (unlike outbox_events' nullable column), so this is the
-- plain column-match + GUC-unset escape valve template, not the nullable
-- variant. No WITH CHECK given explicitly — Postgres reuses USING as the
-- WITH CHECK expression for FOR ALL policies when one isn't specified,
-- matching acl_entries/access_rules/role_permissions/audit_logs exactly.
--
-- Like the rest of the series this is inert under the superuser dev role
-- and becomes live once DB_USER is edams_app — already required in
-- production by assertProductionRuntimeRequirements (config/env.ts).

ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_holds_tenant_isolation ON legal_holds;
CREATE POLICY legal_holds_tenant_isolation ON legal_holds
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );
