-- Reverts 20260710000001-rls-remaining-tenant-tables.sql, using the exact
-- down() draft already sketched at the bottom of that file.
--
-- ORDERING NOTE (part of the 7-migration RLS chain — see
-- 20260615000002-rls-policies.down.sql for the full list): this must run
-- AFTER 20260717000003-rls-guc-empty-string-unset.sql's down, which restores
-- these same 6 policies (access_rules, acl_entries, audit_logs,
-- notifications, role_permissions, users) to the exact body this migration
-- originally created. `migrate down`'s natural reverse-chronological order
-- already guarantees that — this file's DROP POLICY statements work
-- regardless of the exact body, but the sequencing is what keeps the
-- intermediate state semantically correct if a rollback is ever paused
-- partway through the chain via `--to`.
DROP POLICY IF EXISTS users_tenant_isolation ON users;
DROP POLICY IF EXISTS users_insert_unlinked ON users;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
ALTER TABLE role_permissions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acl_entries_tenant_isolation ON acl_entries;
ALTER TABLE acl_entries DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS access_rules_tenant_isolation ON access_rules;
ALTER TABLE access_rules DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
