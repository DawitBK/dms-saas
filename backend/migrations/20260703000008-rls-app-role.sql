-- S6-06 (Phase 6 "RLS done right"): dedicated non-superuser application role.
--
-- ══════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE ASSUMING RLS IS "ON" ANYWHERE THIS MIGRATION HAS RUN:
--
-- Creating `edams_app` here does NOT, by itself, turn on row-level-security
-- enforcement. PostgreSQL superusers — and any role with the BYPASSRLS
-- attribute — ignore RLS policies unconditionally at the server level; no
-- policy predicate written in SQL can override that rule. It is not an
-- application concern, it's how Postgres works.
--
-- This repo's dev DB_USER is `postgres`. Verified live against the dev DB
-- this migration targets:
--
--     SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';
--     ─────────┬──────────┬──────────────
--      rolname │ rolsuper │ rolbypassrls
--     ─────────┼──────────┼──────────────
--      postgres│ t        │ t
--
-- i.e. RLS is 100% bypassed today in this environment, regardless of what
-- the policies in 20260615000002-rls-policies.sql or 20260703000009 /
-- 20260703000010 (below) say. Running this migration is functionally a
-- no-op for request behavior right now.
--
-- RLS becomes load-bearing ONLY once an environment's application DB
-- connection is switched (its DB_USER/DB_PASSWORD config — NOT touched by
-- this migration) to a role such as `edams_app` that has neither SUPERUSER
-- nor BYPASSRLS. That switch is a deployment decision, intentionally left
-- OUT of scope here: flipping DB_USER in this shared dev `.env` would break
-- every other session currently using this database as `postgres`.
--
-- TODO (deployment, not code): whoever enables RLS enforcement for a given
-- environment must (a) set that environment's DB_USER/DB_PASSWORD to
-- `edams_app` / a rotated secret, (b) rotate the placeholder password set
-- below via a secrets manager — it is NOT safe to use as committed here —
-- and (c) re-verify `rolbypassrls = false` for whatever role is actually
-- configured before relying on RLS for tenant isolation.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edams_app') THEN
    -- Placeholder password — MUST be rotated out-of-band (secrets manager)
    -- before this role is ever used as a live application connection.
    CREATE ROLE edams_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION
      PASSWORD 'edams_app_change_me_before_use';
  ELSE
    -- Idempotent re-run safety: make sure a pre-existing role still has the
    -- attributes RLS enforcement depends on.
    ALTER ROLE edams_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

-- Grant connect access to whatever database this migration runs against
-- (avoids hardcoding the DB name, which differs between dev/test/prod).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO edams_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO edams_app;

-- Exactly the privileges the app needs: full row CRUD on every existing
-- table, and USAGE (+ SELECT, for currval()/reading sequence state) on every
-- existing sequence (auto-increment / gap-free allocators like
-- letter_sequences).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO edams_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO edams_app;

-- Cover tables/sequences created by FUTURE migrations too. Default
-- privileges are keyed by the role that CREATEs the object; migrations run
-- as `postgres` (see scripts/migrate.ts / DB_USER), so grant "for objects
-- postgres creates next" explicitly rather than relying on the ambiguous
-- "current role" default.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edams_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO edams_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM edams_app;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM edams_app;
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM edams_app;
-- REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM edams_app;
-- REVOKE USAGE ON SCHEMA public FROM edams_app;
-- DROP ROLE IF EXISTS edams_app;
