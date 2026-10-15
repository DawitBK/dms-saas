-- RLS cutover rehearsal finding (Session 21): writeAuditLog's cold-cache
-- sequence self-heal calls setval(), which requires UPDATE on the sequence.
-- 20260703000008-rls-app-role.sql granted edams_app only USAGE, SELECT on
-- sequences, so under the non-superuser role the very first audited action
-- per process (login included) failed with 42501 and poisoned its request
-- transaction. The code side now tolerates the missing privilege (the heal
-- is advisory); this grant makes the heal actually work under edams_app.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edams_app') THEN
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO edams_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO edams_app;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- down()
-- REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM edams_app;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT USAGE, SELECT ON SEQUENCES TO edams_app;  -- (restore the narrower default)
