-- Reverts 20260717000002-rls-app-role-sequence-update.sql. The up-file's own
-- down() draft only re-GRANTed the narrower USAGE/SELECT default (it never
-- explicitly REVOKEd UPDATE from the default-privilege template) — that
-- would have left UPDATE permanently baked into future tables' default ACL,
-- since `ALTER DEFAULT PRIVILEGES ... GRANT` is additive, not a replace. This
-- version explicitly REVOKEs UPDATE from both the live grant and the default
-- privilege template, so the rollback actually restores the pre-migration
-- state instead of only partially narrowing it.
--
-- ORDERING NOTE (part of the 7-migration RLS chain — see
-- 20260615000002-rls-policies.down.sql for the full list): this is the FIRST
-- down to run in the chain (last migration, chronologically), before
-- 20260717000003-rls-guc-empty-string-unset.sql's down. No interaction
-- between the two — this one only touches sequence privileges, that one only
-- touches policy bodies.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edams_app') THEN
    REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM edams_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE UPDATE ON SEQUENCES FROM edams_app;
  END IF;
END
$$;
