-- FIX: users_tenant_isolation required a user_tenants membership row for
-- the ACTIVE tenant before a `users` row was visible at all -- correct for
-- looking up someone ELSE's profile, wrong for a user reading their OWN
-- row. A PLATFORM_ADMIN can switch into any tenant with no user_tenants row
-- there whatsoever (auth.service.ts's switchTenant bypass, by design), so
-- GET /users/me 404'd with "User not found" the moment that account
-- switched into a tenant it isn't a member of -- even though it was asking
-- for its own identity, not anyone else's. Reproduced live: dave b
-- (PLATFORM_ADMIN) switched into dave-tenant (no membership row there) and
-- got "User not found" on /settings, with role/permissions still resolving
-- fine (those come from the session/JWT, not this query).
--
-- A user can always see their own row now, tenant membership or not --
-- identity isn't tenant-owned data the way a document or department is.
-- app.current_user_id is a new GUC (shared/middleware.ts's tenantContext),
-- set from the authenticated JWT's own user id, never client input.
ALTER POLICY users_tenant_isolation ON users
USING (
  (NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
  OR (users.id::text = NULLIF(current_setting('app.current_user_id', true), ''))
  OR (EXISTS (
    SELECT 1 FROM user_tenants ut
    WHERE ut.user_id = users.id
      AND ut.tenant_id::text = NULLIF(current_setting('app.current_tenant', true), '')
  ))
);
