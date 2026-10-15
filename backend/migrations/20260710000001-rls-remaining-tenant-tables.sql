-- S6-07 ("RLS done right", part 2): extend row-level security to the
-- remaining tenant-scoped tables flagged by the security audit
-- (UNKNOWN-UNKNOWNS-DMS.md finding #20) as having NO RLS policy at all:
-- users, roles, role_permissions, audit_logs, acl_entries, access_rules,
-- notifications, outbox_events.
--
-- Same caveat as every other migration in this series: this is inert until
-- the app's DB connection is switched from the superuser `postgres` DB_USER
-- to a non-superuser role such as `edams_app` (see 20260703000008/009/010).
--
-- IMPORTANT — this batch is NOT a copy-paste of the simple
-- `tenant_id = current_setting(...)` template used for documents/letters/etc.
-- Each table's actual shape was checked against its Sequelize model and real
-- call sites before writing its policy. Three tables in the audit's list
-- turned out NOT to fit that template at all, for three different reasons
-- documented inline below: `roles` (genuinely global, no tenant_id column),
-- `users` (no tenant_id column — membership is a many-to-many via
-- `user_tenants`, and account lookup legitimately happens BEFORE a tenant is
-- selected), and `outbox_events` (no tenant_id column, and its background
-- poller claims rows across every tenant in one query with no tenant GUC set
-- at all — deliberately left out of this migration, see bottom).
--
-- A recurring nuance across `users`, `role_permissions`, and `audit_logs`:
-- grep for `resolveUnionPermissions` / `User.findOne({ where: { email } })`
-- in modules/auth/auth.routes.ts shows login, select-tenant, refresh, and
-- MFA-validate all run BEFORE `tenantContext` middleware ever runs (that
-- middleware is only mounted on `protectedRoutes`, and `/auth/*` is mounted
-- directly on `v1Routes`) — so `app.current_tenant` is NOT SET for any of
-- those queries, by design, since the whole point of that phase is figuring
-- out which tenant(s) a user belongs to before one is chosen. A restrictive
-- policy with no allowance for "no tenant context established yet" would
-- silently break login (RolePermission lookups falling back to hardcoded
-- static defaults instead of the tenant's actual custom grants) or, for a
-- literal `users` policy, break it outright (the login row itself becomes
-- invisible). Every policy below that could plausibly run in that pre-tenant
-- window therefore includes an explicit
-- `OR current_setting('app.current_tenant', true) IS NULL` escape valve —
-- this does not weaken enforcement for the (large) majority of requests that
-- DO run inside `tenantContext`/`withWorkerTenantContext`, it only avoids
-- turning "no tenant chosen yet" into "no rows visible".

-- ═══════════════════════════════════════════════════════════════════════════
-- users — NO tenant_id column. Membership is many-to-many via `user_tenants`
-- (see migrations/20260628000001-user-tenants.sql); a user can legitimately
-- belong to more than one tenant. `/auth/select-tenant` is the sole gate that
-- checks `user_tenants` membership before issuing a tenant-scoped token, so
-- by the time any *other* request runs with `app.current_tenant` set, the
-- acting user is guaranteed to already have a `user_tenants` row for that
-- tenant — the EXISTS join below never blocks a legitimate "view my own
-- profile" or "view members of my own tenant" query.
--
-- Today `modules/users/users.service.ts#listUsers` queries `User.findAll`
-- with NO tenant scoping at all (a real cross-tenant enumeration gap the
-- audit didn't call out by name but this policy incidentally closes once RLS
-- is actually enforced — worth knowing, since it changes that endpoint's
-- result set from "every user in the system" to "members of my tenant").
--
-- INSERT needs its own unconditional policy: `createUser` inserts a brand
-- new `users` row with NO corresponding `user_tenants` row yet (tenant
-- membership is a separate follow-up step via `POST /tenants/:id/members`),
-- so requiring EXISTS-membership on INSERT would reject every user creation
-- the moment a tenant context IS set (which is the normal case for that
-- route). Since nothing sensitive is readable from the bare fact that a row
-- was insertable, an unconditional INSERT policy is the correct shape here,
-- not a compromise.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    current_setting('app.current_tenant', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = users.id
        AND ut.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

DROP POLICY IF EXISTS users_insert_unlinked ON users;
CREATE POLICY users_insert_unlinked ON users
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- roles — DELIBERATELY SKIPPED. `src/infrastructure/database/models/Role.ts`
-- has no tenantId field at all (`id`, `name`, `description` only) — role
-- NAMES (SYSTEM_ADMIN, DEPT_MANAGER, ...) are global reference data shared
-- by every tenant. Per-tenant customization lives one table over, in
-- `role_permissions` (which DOES have a tenant_id and gets a policy below).
-- Adding a tenant-matching RLS policy to `roles` itself would either hide
-- the shared role catalog from every tenant (if naively requiring
-- tenant_id = current tenant on a table that has no such column, this isn't
-- even expressible) or require a meaningless always-true policy that adds
-- nothing. No ALTER TABLE / CREATE POLICY for `roles` in this migration.

-- ═══════════════════════════════════════════════════════════════════════════
-- role_permissions — HAS a direct tenant_id column (VARCHAR, matches the
-- tenant slug convention, not a UUID) — this is where per-tenant permission
-- grants for a (global) role actually live. Standard column-match policy,
-- plus the pre-tenant-context escape valve described above (needed because
-- `resolveUnionPermissions` — used by login/select-tenant/refresh/MFA in
-- auth.routes.ts — queries this table by an explicit tenantId parameter
-- before `tenantContext` middleware has ever run for that request).

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- audit_logs — tenant_id is NULLABLE (`AuditLog.ts`: `tenantId: string | null`)
-- for system-level events with no owning tenant (see
-- `AUDIT_SYSTEM_CHAIN_KEY` in modules/audit/audit.service.ts). The app's own
-- `/audit` routes already deliberately exclude NULL-tenant rows from
-- tenant-scoped reads via an explicit `WHERE tenant_id = req.user.tenantId`
-- (see the "Tenant-scoped: pre-migration rows (tenant_id NULL) are not
-- exposed" comment in audit.routes.ts) — that SQL equality is false, not
-- true, for a NULL column value, so RLS being permissive about NULL rows
-- does not undo that app-level filter. It DOES matter for two things this
-- policy needs to keep working: (1) `verifyAuditChain()` verifying the
-- system-level hash chain (tenantId argument omitted/undefined → NULL
-- rows), and (2) `writeAuditLog()` being called from several places in
-- auth.routes.ts (login failures, MFA, etc.) that run before any tenant is
-- selected, i.e. with `app.current_tenant` unset — those INSERTs (some with
-- tenant_id NULL, some with an explicit tenantId once a tenant IS known)
-- must not be rejected by RLS's WITH CHECK just because the GUC hasn't been
-- set on this connection/transaction.

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR tenant_id IS NULL
    OR current_setting('app.current_tenant', true) IS NULL
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- acl_entries — HAS a direct tenant_id column (VARCHAR, NOT NULL). Standard
-- column-match policy. Only ever read/written from modules/acl,
-- shared/resolveACL.ts, workflow.service.ts and folders.service.ts — all of
-- which run inside tenant-scoped requests or worker contexts that DO set
-- `app.current_tenant` — but the same unset-GUC escape valve is included for
-- consistency and because it costs nothing: a request with no tenant context
-- has no tenant-scoped ACL check to make in the first place.

ALTER TABLE acl_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acl_entries_tenant_isolation ON acl_entries;
CREATE POLICY acl_entries_tenant_isolation ON acl_entries
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- access_rules — HAS a direct tenant_id column (VARCHAR, NOT NULL). Same
-- shape and reasoning as acl_entries.

ALTER TABLE access_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS access_rules_tenant_isolation ON access_rules;
CREATE POLICY access_rules_tenant_isolation ON access_rules
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
    OR current_setting('app.current_tenant', true) IS NULL
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- notifications — NO tenant_id column (`Notification.ts`: id, userId,
-- documentId, letterId, type, title, body, isRead, readAt, createdAt only).
-- Every app-level read is already scoped to the exact requesting user
-- (`WHERE userId = req.user.userId` in notifications.routes.ts, or an
-- explicit `notification.userId !== user.userId` ownership check before any
-- mutation) — stronger than tenant isolation, since it's per-identity, not
-- per-tenant. RLS's job here is the same tenant-boundary backstop as
-- everywhere else, expressed via the owning user's `user_tenants`
-- membership, so a query that (by bug) forgot its own userId filter still
-- can't return another tenant's notifications.
--
-- Unlike `users`, no separate always-true INSERT policy is needed: a
-- notification row always references an ALREADY-EXISTING user
-- (`fanOut()` in modules/notifications/notifications.service.ts targets
-- either explicit recipientIds or existing SYSTEM_ADMIN role holders), so
-- by the time a notification is inserted for that user under a specific
-- tenant context, that user is expected to already hold a `user_tenants` row
-- for it. The unset-GUC escape valve alone covers the (common) case of
-- `fanOut` being invoked from a worker/background path that hasn't
-- established a tenant GUC at all.

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
CREATE POLICY notifications_tenant_isolation ON notifications
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    current_setting('app.current_tenant', true) IS NULL
    OR EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = notifications.user_id
        AND ut.tenant_id = nullif(current_setting('app.current_tenant', true), '')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- outbox_events — DELIBERATELY SKIPPED, for two independent reasons, either
-- one of which would be sufficient on its own:
--
-- 1. The table has NO tenant_id column at all
--    (`OutboxEvent.ts`: id, documentId, type, channel, payload, status,
--    attempts, maxAttempts, errorMsg, processAfter, processingStartedAt,
--    processedAt, createdAt — confirmed against the model and every
--    migration touching this table). Tenant is only ever known indirectly,
--    by parsing the JSON `payload` column (which may or may not carry a
--    `tenantId` key depending on event type) — there is no column for a row
--    policy to compare against without a schema migration to add one and
--    backfill it from that JSON, which is a materially bigger change than
--    "add a policy" and out of scope for this pass.
--
-- 2. Even with a tenant_id column, the poller in
--    infrastructure/queue/outbox.ts#processOutbox claims work with:
--
--        SELECT id FROM outbox_events WHERE ... ORDER BY created_at ASC
--        LIMIT 20 FOR UPDATE SKIP LOCKED
--
--    in a single query that intentionally spans EVERY tenant's due events in
--    one poll cycle, running as the API process's own background interval
--    (`setInterval(processOutbox, ...)`) with NO request context and NO
--    `app.current_tenant` GUC set — it is not wrapped in
--    `withWorkerTenantContext` (unlike e.g. the retention/workflow sweeps),
--    and structurally can't be: the whole point of the claim query is to
--    pick up whichever tenant's rows are due next, before it's known which
--    tenant that is. A tenant-matching USING clause evaluated with the GUC
--    unset would need its own "unset → visible" escape valve (as used
--    elsewhere in this migration) to avoid returning zero rows — but for
--    THIS table that escape valve would make the policy a no-op for the one
--    query that actually matters (the poller's claim, which is always
--    GUC-unset), while doing nothing to stop a hypothetical *tenant-scoped*
--    request from reading this table directly (nothing in this codebase
--    does that today — `outbox_events` has no read API of its own).
--
-- Net effect: a policy here would either (a) be permissive enough to be
-- inert for the one process that actually touches this table at volume, or
-- (b) break the poller outright by making its claim query return nothing
-- once DB_USER is switched to a non-superuser role. Neither is worth doing
-- today. Follow-up, if this table's isolation needs strengthening: add a
-- tenant_id column (backfilled from payload->>'tenantId' where present) and
-- either loop the poller per-tenant under `withWorkerTenantContext`, or keep
-- it a single cross-tenant query but run it under a role that has an
-- explicit BYPASSRLS-equivalent (e.g. a narrow policy granted only to a
-- dedicated `edams_outbox_poller` role) — a real design decision, not a
-- one-line policy, so it's left for a dedicated follow-up rather than
-- guessed at here.

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- DROP POLICY IF EXISTS users_tenant_isolation ON users;
-- DROP POLICY IF EXISTS users_insert_unlinked ON users;
-- ALTER TABLE users DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
-- ALTER TABLE role_permissions DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
-- ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS acl_entries_tenant_isolation ON acl_entries;
-- ALTER TABLE acl_entries DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS access_rules_tenant_isolation ON access_rules;
-- ALTER TABLE access_rules DISABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
-- ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
