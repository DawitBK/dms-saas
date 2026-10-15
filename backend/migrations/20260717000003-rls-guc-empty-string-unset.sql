-- RLS cutover rehearsal finding (Session 21, HIGH): "no tenant context" arms
-- written as `current_setting('app.current_tenant', true) IS NULL` stop
-- matching after a pooled connection has served even ONE tenant-scoped
-- request. `SET LOCAL app.current_tenant = ...` reverts at COMMIT to the
-- session value — and for a custom GUC that was never set at session level,
-- Postgres materializes that as the EMPTY STRING, not NULL (verified live:
-- after BEGIN; SET LOCAL ...; COMMIT → current_setting(..., true) IS NULL is
-- false, = '' is true). Result under the edams_app role: pre-auth paths
-- (login user lookup, role_permissions reads, notifications fan-out, audit
-- reads) nondeterministically saw zero rows depending on which pooled
-- connection they drew. Fails closed (no cross-tenant leak) but breaks
-- availability. Fix: treat '' as unset via NULLIF in every fail-open arm.
-- The tenant-match arms already used NULLIF and were correct.

-- ─── access_rules ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS access_rules_tenant_isolation ON access_rules;
CREATE POLICY access_rules_tenant_isolation ON access_rules
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR nullif(current_setting('app.current_tenant', true), '') IS NULL
  );

-- ─── acl_entries ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS acl_entries_tenant_isolation ON acl_entries;
CREATE POLICY acl_entries_tenant_isolation ON acl_entries
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR nullif(current_setting('app.current_tenant', true), '') IS NULL
  );

-- ─── audit_logs ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR tenant_id IS NULL
    OR nullif(current_setting('app.current_tenant', true), '') IS NULL
  );

-- ─── notifications ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
CREATE POLICY notifications_tenant_isolation ON notifications
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    nullif(current_setting('app.current_tenant', true), '') IS NULL
    OR EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = notifications.user_id
        AND ut.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

-- ─── role_permissions ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR nullif(current_setting('app.current_tenant', true), '') IS NULL
  );

-- ─── users ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    nullif(current_setting('app.current_tenant', true), '') IS NULL
    OR EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = users.id
        AND ut.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- Recreate each policy with the bare `current_setting('app.current_tenant', true) IS NULL`
-- arm (the pre-rehearsal form) — not recommended; that form breaks on pooled connections.
