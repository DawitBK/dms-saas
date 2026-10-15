-- Seeds the PLATFORM_ADMIN role row so it can be granted via the ordinary
-- user_roles mechanism (UserRole.findOrCreate), same as every other role.
-- No schema change needed -- roles.name is a plain VARCHAR(50) UNIQUE with
-- no enum/check constraint (see baseline.sql) -- this is data-only.
--
-- What this role means is defined in code, not here: config/permissions.ts's
-- ROLE_PERMISSIONS.PLATFORM_ADMIN = Object.values(PERMISSIONS) (every
-- ordinary SYSTEM_ADMIN permission, in every tenant, since role_permissions
-- resolution falls back to this static set for any tenant with no override
-- rows) PLUS PERMISSIONS.PLATFORM_ADMIN itself -- the cross-tenant flag that
-- tenants.routes.ts's assertOwnTenant and auth.service.ts's switchTenant
-- check for. Deliberately the only role meant to hold that flag; see the
-- PLATFORM_ONLY_PERMISSIONS comment in permissions.ts.
INSERT INTO roles (id, name, description)
VALUES (
  gen_random_uuid(),
  'PLATFORM_ADMIN',
  'Cross-tenant platform operator: full SYSTEM_ADMIN rights in every tenant, plus platform-level tenant creation/registry control and the ability to switch into any tenant without a user_tenants membership row.'
)
ON CONFLICT (name) DO NOTHING;
