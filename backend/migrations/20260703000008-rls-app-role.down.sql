-- Reverts 20260703000008-rls-app-role.sql, using the down() draft already
-- sketched at the bottom of that file, wrapped in an existence guard so this
-- is safe to run even if the role was somehow never created (or already
-- dropped by a previous partial rollback).
--
-- ORDERING NOTE (part of the 7-migration RLS chain — see
-- 20260615000002-rls-policies.down.sql for the full list): this must run
-- AFTER 20260717000002-rls-app-role-sequence-update.sql's down (which revokes
-- edams_app's UPDATE-on-sequences grant) and AFTER every policy-dropping
-- down.sql that references edams_app implicitly — `migrate down`'s natural
-- reverse-chronological order already guarantees this. REVOKE ALL below mops
-- up whatever grants remain regardless of exactly which prior downs ran, so
-- DROP ROLE does not fail with "role has grants" even if something upstream
-- was skipped.
--
-- Dropping edams_app is a no-op for data (it never owned any table — only
-- held GRANTed privileges), but note DEPLOYMENT-GUIDE.md/any environment that
-- was actually switched to run its app connection AS edams_app would lose its
-- login role entirely. This down.sql is only intended for a dev/scratch
-- rollback rehearsal, never for an environment with a live edams_app
-- connection.
--
-- VERIFIED LIVE (full up/down dry run on a scratch DB, 2026-08-29): a ROLE is
-- a cluster-wide object in Postgres, not a per-database one — on this
-- platform's shared local instance (SSO/GMS/DMS/MRS all on one Postgres
-- server, per root CLAUDE.md), `edams_app` can independently hold GRANTed
-- privileges in OTHER databases on the same instance (e.g. the real dev
-- `DMS` database, or a leftover `dms_rls_rehearsal` scratch DB from earlier
-- work) purely because this same migration was also run there. `DROP ROLE`
-- then fails with `2BP01 dependent_objects_still_exist`, correctly refusing
-- to silently orphan those other databases' grants — and this down.sql must
-- not (and, running against just one database, cannot) reach into another
-- database to clean those up itself. The REVOKEs above already undo
-- everything THIS migration granted in the database this file is actually
-- running against, which is the correct scope of responsibility here; the
-- DROP ROLE is wrapped so that failure leaves the (now-empty-in-this-database)
-- role in place with a NOTICE instead of aborting the whole rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edams_app') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM edams_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM edams_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM edams_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM edams_app;
    REVOKE USAGE ON SCHEMA public FROM edams_app;
    BEGIN
      DROP ROLE edams_app;
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE NOTICE 'edams_app still holds privileges in another database on this Postgres instance (roles are cluster-wide) — every grant this migration made in THIS database has been revoked, but the role itself was left in place rather than risk orphaning another database''s grants. Drop it manually once no other database on this instance depends on it.';
    END;
  END IF;
END
$$;
