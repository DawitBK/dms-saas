-- Platform administrator protection, database layer (brief item 5.14).
--
-- The application already treats the PLATFORM_ADMIN account as invisible and
-- untouchable (shared/platformAdmin.ts). This migration repeats the rule in the
-- database so it holds even if an endpoint forgets it, and so a person at a SQL
-- prompt is held to it too:
--
--  1. A vault. A password (chosen by the platform owner with
--     scripts/platform-vault.ts, never stored in any file or env var, never
--     known to the application) is the only thing that lets a session change the
--     account. Only a bcrypt hash is stored. platform_vault_unlock(password)
--     opens the vault for ONE database session for a few minutes.
--       - Failures are counted in a SEQUENCE, which (unlike a table row) is not
--         rolled back, so `BEGIN; select platform_vault_unlock('guess'); ROLLBACK;`
--         cannot be used to guess without being counted. After 10 consecutive
--         failures the vault refuses everything until the owner resets it
--         (scripts/platform-vault.ts reset-lockout (or forget), run as the database superuser).
--
--  2. Guard triggers. Without the vault open, nothing can delete the account,
--     deactivate it, change its email, grant or remove its role, edit that role's
--     permissions, remove its tenant memberships, or change its permission
--     overrides. A failed-login lockout (locked_until) is silently ignored for it,
--     so guessing its password can never lock it out.
--
--  3. A restrictive row-level-security policy on `users`: in a tenant-scoped
--     session the platform admin's row is visible only to itself. Sessions with
--     no tenant set (login, refresh, workers, scripts) are unaffected, which is
--     exactly the set of code that has to read the account to sign it in.
--
-- WHAT THIS CANNOT DO: a PostgreSQL superuser (and the table owner, where the
-- application's own role owns the tables) can always drop a trigger or a policy.
-- That is why the protection also lives in the application and why the owner is
-- told to keep the superuser password to themselves. See
-- /PLATFORM-ADMIN-AUTONOMY.md at the repository root.
--
-- SAFE: adds a table, functions, triggers and one policy only. Nothing existing is
-- altered, dropped or backfilled; the DROP statements below only remove this
-- migration's own previous objects so it can be re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------ vault ---

CREATE TABLE IF NOT EXISTS platform_vault (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  secret_hash text NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_vault_unlocked (
  pid           integer     NOT NULL,
  backend_start timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (pid, backend_start)
);

CREATE TABLE IF NOT EXISTS platform_vault_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  event   text NOT NULL,           -- unlock_ok | unlock_failed | lock | set | reset
  db_user text NOT NULL DEFAULT session_user
);

-- Non-transactional failure counter (see header, point 1).
-- MINVALUE 1 / START 1: the count is last_value once it has been called, else 0
-- (see platform_vault_failure_count()); setval(seq, 1, false) resets it to 0.
CREATE SEQUENCE IF NOT EXISTS platform_vault_failures MINVALUE 1 START 1;

REVOKE ALL ON platform_vault, platform_vault_unlocked, platform_vault_log FROM PUBLIC;
REVOKE ALL ON SEQUENCE platform_vault_failures FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edams_app') THEN
    -- Default privileges granted this role everything on new tables; take it back.
    REVOKE ALL ON platform_vault, platform_vault_unlocked, platform_vault_log FROM edams_app;
    REVOKE ALL ON SEQUENCE platform_vault_failures FROM edams_app;
    REVOKE ALL ON SEQUENCE platform_vault_log_id_seq FROM edams_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION platform_vault_failure_count() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM platform_vault_failures;
$$;
REVOKE ALL ON FUNCTION platform_vault_failure_count() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform_vault_is_unlocked() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_vault_unlocked u
     WHERE u.pid = pg_backend_pid()
       AND u.backend_start = (SELECT a.backend_start FROM pg_stat_activity a WHERE a.pid = pg_backend_pid())
       AND u.expires_at > now()
  );
$$;

CREATE OR REPLACE FUNCTION platform_vault_unlock(p_password text, p_minutes integer DEFAULT 10)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_hash   text;
  v_ok     boolean;
  v_fails  bigint;
BEGIN
  v_fails := platform_vault_failure_count();
  IF v_fails >= 10 THEN
    RAISE EXCEPTION 'platform vault is locked after repeated failures; the owner must reset it' USING ERRCODE = '42501';
  END IF;

  SELECT secret_hash INTO v_hash FROM platform_vault WHERE id = 1;
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'platform vault has no password set' USING ERRCODE = '42501';
  END IF;

  v_ok := (crypt(coalesce(p_password, ''), v_hash) = v_hash);
  IF NOT v_ok THEN
    PERFORM nextval('platform_vault_failures');
    INSERT INTO platform_vault_log (event) VALUES ('unlock_failed');
    RETURN false;
  END IF;

  PERFORM setval('platform_vault_failures', 1, false);
  DELETE FROM platform_vault_unlocked WHERE expires_at <= now();
  INSERT INTO platform_vault_unlocked (pid, backend_start, expires_at)
  VALUES (
    pg_backend_pid(),
    (SELECT a.backend_start FROM pg_stat_activity a WHERE a.pid = pg_backend_pid()),
    now() + make_interval(mins => least(greatest(coalesce(p_minutes, 10), 1), 60))
  )
  ON CONFLICT (pid, backend_start) DO UPDATE SET expires_at = EXCLUDED.expires_at;
  INSERT INTO platform_vault_log (event) VALUES ('unlock_ok');
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION platform_vault_lock() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM platform_vault_unlocked WHERE pid = pg_backend_pid();
$$;

REVOKE ALL ON FUNCTION platform_vault_is_unlocked() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_vault_unlock(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_vault_lock() FROM PUBLIC;
-- Anyone may ASK (that is how the owner unlocks from any client); only the
-- correct password makes it succeed, and failures are counted above.
GRANT EXECUTE ON FUNCTION platform_vault_unlock(text, integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION platform_vault_lock() TO PUBLIC;
-- is_unlocked is called by policies and triggers of every role; it reveals nothing but a boolean.
GRANT EXECUTE ON FUNCTION platform_vault_is_unlocked() TO PUBLIC;

-- ----------------------------------------------------- who is the platform admin

CREATE OR REPLACE FUNCTION dms_is_platform_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = p_user AND r.name = 'PLATFORM_ADMIN'
  );
$$;
REVOKE ALL ON FUNCTION dms_is_platform_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dms_is_platform_admin(uuid) TO PUBLIC;

-- ---------------------------------------------------------------- triggers ---

CREATE OR REPLACE FUNCTION platform_admin_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_user uuid;
  v_role_is_pa boolean;
BEGIN
  IF platform_vault_is_unlocked() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- An update that changes ONLY who is recorded as having made the grant (assigned_by /
  -- granted_by) or bookkeeping timestamps does not change the account, its role, its tenant
  -- seat or its permissions. Allowing it is what lets a demo user that once assigned the
  -- platform administrator's seat be removed (the reference is cleared, nothing else moves).
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('user_roles', 'user_tenants', 'user_permission_overrides') THEN
    IF (to_jsonb(NEW) - 'assigned_by' - 'granted_by' - 'updated_at')
       = (to_jsonb(OLD) - 'assigned_by' - 'granted_by' - 'updated_at') THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'users' THEN
    IF TG_OP = 'DELETE' THEN
      IF dms_is_platform_admin(OLD.id) THEN
        RAISE EXCEPTION 'the platform administrator account cannot be deleted' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    -- UPDATE
    IF dms_is_platform_admin(OLD.id) THEN
      IF NEW.is_active IS DISTINCT FROM true
         OR NEW.deleted_at IS NOT NULL
         OR NEW.email IS DISTINCT FROM OLD.email THEN
        RAISE EXCEPTION 'the platform administrator account cannot be deactivated, deleted or renamed' USING ERRCODE = '42501';
      END IF;
      -- Failed-login lockout must never be able to lock this account out.
      NEW.locked_until := NULL;
    END IF;
    RETURN NEW;

  ELSIF TG_TABLE_NAME = 'roles' THEN
    IF OLD.name = 'PLATFORM_ADMIN' THEN
      RAISE EXCEPTION 'the platform administrator role cannot be changed or removed' USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    -- granting it, changing it, or taking it away
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      SELECT (name = 'PLATFORM_ADMIN') INTO v_role_is_pa FROM roles WHERE id = NEW.role_id;
      IF coalesce(v_role_is_pa, false) THEN
        RAISE EXCEPTION 'the platform administrator role can only be granted through the vault' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      SELECT (name = 'PLATFORM_ADMIN') INTO v_role_is_pa FROM roles WHERE id = OLD.role_id;
      IF coalesce(v_role_is_pa, false) THEN
        RAISE EXCEPTION 'the platform administrator role cannot be removed' USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  ELSIF TG_TABLE_NAME = 'role_permissions' THEN
    SELECT (name = 'PLATFORM_ADMIN') INTO v_role_is_pa FROM roles
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
    IF coalesce(v_role_is_pa, false) THEN
      RAISE EXCEPTION 'the platform administrator role permissions cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  ELSE
    -- user_tenants, user_permission_overrides: both carry user_id
    v_user := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    IF dms_is_platform_admin(v_user) AND TG_OP IN ('DELETE', 'UPDATE') THEN
      RAISE EXCEPTION 'the platform administrator account cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'user_permission_overrides' AND TG_OP = 'INSERT' AND dms_is_platform_admin(v_user) THEN
      RAISE EXCEPTION 'the platform administrator account cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
END $$;

DROP TRIGGER IF EXISTS platform_admin_guard_users ON users;
CREATE TRIGGER platform_admin_guard_users
  BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION platform_admin_guard();

DROP TRIGGER IF EXISTS platform_admin_guard_roles ON roles;
CREATE TRIGGER platform_admin_guard_roles
  BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION platform_admin_guard();

DROP TRIGGER IF EXISTS platform_admin_guard_user_roles ON user_roles;
CREATE TRIGGER platform_admin_guard_user_roles
  BEFORE INSERT OR UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION platform_admin_guard();

DROP TRIGGER IF EXISTS platform_admin_guard_role_permissions ON role_permissions;
CREATE TRIGGER platform_admin_guard_role_permissions
  BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION platform_admin_guard();

DROP TRIGGER IF EXISTS platform_admin_guard_user_tenants ON user_tenants;
CREATE TRIGGER platform_admin_guard_user_tenants
  BEFORE UPDATE OR DELETE ON user_tenants
  FOR EACH ROW EXECUTE FUNCTION platform_admin_guard();

DROP TRIGGER IF EXISTS platform_admin_guard_user_permission_overrides ON user_permission_overrides;
CREATE TRIGGER platform_admin_guard_user_permission_overrides
  BEFORE INSERT OR UPDATE OR DELETE ON user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION platform_admin_guard();

-- ------------------------------------------------------------- invisibility ---

-- RESTRICTIVE: ANDed with the existing users_tenant_isolation policy, never
-- widening it. A row is hidden only when ALL of these are true: it is a
-- platform admin, the session has a tenant (an authenticated application
-- request), the session is not that user, and the vault is closed.
DROP POLICY IF EXISTS users_hide_platform_admin ON users;
CREATE POLICY users_hide_platform_admin ON users
  AS RESTRICTIVE
  FOR SELECT
  TO PUBLIC
  USING (
    NOT dms_is_platform_admin(id)
    OR id::text = nullif(current_setting('app.current_user_id', true), '')
    OR nullif(current_setting('app.current_tenant', true), '') IS NULL
    OR platform_vault_is_unlocked()
  );
