-- fix-vault-function-owner.sql
--
-- Migration 20261004000002-platform-admin-protection makes user_roles and users call platform_vault_is_unlocked(), a SECURITY DEFINER function, and it
-- revokes the platform-vault tables from edams_app. A SECURITY DEFINER function runs as its OWNER, so the migration has to be applied as the database
-- superuser (DB_MIGRATE_USER, the Docker split: migrate as postgres, run the app as edams_app). If it was applied as edams_app, the functions are owned
-- by the role that was just locked out of the vault tables, and every INSERT into user_roles (and any read of users that reaches the vault check) fails
-- with "permission denied for table platform_vault_unlocked".
--
-- This moves the six functions to postgres. It changes nothing else: no table, no grant, no data, and edams_app gets no right on the vault tables.
--
-- Run it ONCE per database, as the superuser, after a backup (it is idempotent):
--   psql -h localhost -U postgres -d dmsprod -f scripts\fix-vault-function-owner.sql        (mirror)
--   psql -U postgres -d dmsprod -f scripts\fix-vault-function-owner.sql                      (live server; the database name there is dmsprod too)
-- Do NOT run it on the development database (DMS): there the application already connects as postgres.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Run this as the database superuser (postgres); you are %', current_user;
  END IF;
END $$;

\echo 'Before:'
SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer
  FROM pg_proc p
 WHERE p.proname IN ('platform_vault_is_unlocked', 'platform_admin_guard', 'dms_is_platform_admin',
                     'platform_vault_failure_count', 'platform_vault_unlock', 'platform_vault_lock')
 ORDER BY 1;

BEGIN;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            WHERE p.proname IN ('platform_vault_is_unlocked', 'platform_admin_guard', 'dms_is_platform_admin',
                                'platform_vault_failure_count', 'platform_vault_unlock', 'platform_vault_lock')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', r.sig);
  END LOOP;
END $$;
COMMIT;

\echo 'After (every owner must be postgres):'
SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer
  FROM pg_proc p
 WHERE p.proname IN ('platform_vault_is_unlocked', 'platform_admin_guard', 'dms_is_platform_admin',
                     'platform_vault_failure_count', 'platform_vault_unlock', 'platform_vault_lock')
 ORDER BY 1;
