-- Reverts 20260717000003-rls-guc-empty-string-unset.sql by recreating the
-- same 6 policies in the pre-fix form (bare `current_setting(..., true) IS
-- NULL` arm, no NULLIF), matching this file's own down() comment. NOT
-- RECOMMENDED to actually run against a pooled-connection environment: the
-- whole point of the up-migration was fixing a real availability bug (a
-- pooled connection that already served one tenant-scoped request stops
-- matching "unset" once the custom GUC settles to '' instead of NULL at
-- COMMIT). This down.sql exists to make `migrate down` a true, honest
-- rollback of the schema/policy state — not an endorsement of reverting this
-- fix in any environment that already hit the bug.
--
-- ORDERING NOTE (part of the 7-migration RLS chain — see
-- 20260615000002-rls-policies.down.sql for the full list): this must run
-- BEFORE 20260710000001-rls-remaining-tenant-tables.sql's down (which drops
-- these same 6 policies outright) — `migrate down`'s natural
-- reverse-chronological order already guarantees that.
DROP POLICY IF EXISTS access_rules_tenant_isolation ON access_rules;
CREATE POLICY access_rules_tenant_isolation ON access_rules
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

DROP POLICY IF EXISTS acl_entries_tenant_isolation ON acl_entries;
CREATE POLICY acl_entries_tenant_isolation ON acl_entries
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR tenant_id IS NULL
    OR current_setting('app.current_tenant', true) IS NULL
  );

DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
CREATE POLICY notifications_tenant_isolation ON notifications
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.current_tenant', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = notifications.user_id
        AND ut.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (
    current_setting('app.current_tenant', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = users.id
        AND ut.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );
