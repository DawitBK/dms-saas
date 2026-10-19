-- CI only. Creates a platform administrator in the THROWAWAY database of a CI job.
--
-- scripts/seed-qa-world.ts provisions the qa-lab tenant as the platform
-- administrator, and the database (migration 20261004000002) refuses to create
-- one unless the platform vault is open. In production the vault password is
-- chosen and typed by the owner at a terminal. Here the database is destroyed
-- with the job, so the vault gets a public, meaningless password, opens, makes
-- the account and closes again, all in this one session. Nothing here can
-- reach a real database: the workflow points psql at the job's own service.
--
-- Run after db:seed:core (it needs the `examplecorp` tenant):
--   psql -v ON_ERROR_STOP=1 -f .github/ci/seed-ci-platform-admin.sql
INSERT INTO platform_vault (id, secret_hash)
VALUES (1, crypt('ci-throwaway-vault', gen_salt('bf')))
ON CONFLICT (id) DO NOTHING;

SELECT platform_vault_unlock('ci-throwaway-vault', 5);

BEGIN;
WITH u AS (
  INSERT INTO users (email, first_name, last_name, is_active, password_hash)
  VALUES ('ci-platform-admin@ci.invalid', 'Platform', 'Administrator', TRUE, NULL)
  ON CONFLICT (email) DO UPDATE SET is_active = TRUE, deleted_at = NULL, updated_at = NOW()
  RETURNING id
), r AS (
  INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, ro.id FROM u, roles ro WHERE ro.name = 'PLATFORM_ADMIN'
  ON CONFLICT (user_id, role_id) DO NOTHING
  RETURNING 1
)
INSERT INTO user_tenants (user_id, tenant_id, assigned_by)
SELECT u.id, 'examplecorp', u.id FROM u
ON CONFLICT (user_id, tenant_id) DO NOTHING;
COMMIT;

SELECT platform_vault_lock();
