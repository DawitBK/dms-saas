-- R-04 (AUDIT-FINDINGS-2026-09-03.md): session-revocation cutoffs were held
-- ONLY in Redis (`dms:auth:revoked_user:<id>`, 2-day TTL). Two consequences:
--
--   1. revokeAllUserSessions() is documented to fail CLOSED in production
--      ("if the cutoff cannot be persisted, the revocation is a lie, so we
--      throw") — but three call sites wrapped it in .catch(logger.warn):
--      roles.service.ts's user-permission-override and role-permission
--      changes, and auth.service.ts's force-logout. So DEACTIVATING a user
--      failed closed while DEMOTING one failed open: a user stripped of
--      permissions kept them until token expiry if Redis was down, with only
--      a warning line to show for it. Removing those .catch() calls was not
--      the fix — the permission change had already committed by then, so
--      throwing would 500 on a change that did apply.
--
--   2. A Redis flush or eviction silently un-revoked every outstanding
--      revocation.
--
-- Making Postgres the source of truth fixes both: the cutoff is written in
-- the SAME transaction as the permission change, so the two commit together
-- or not at all, and Redis becomes a read-through cache rather than the
-- record. One row per user, upserted, so the table is bounded by headcount.
--
-- cutoff_at is compared against the JWT `iat` claim (seconds), so second
-- resolution is all that is required; TIMESTAMPTZ keeps it readable and
-- comparable in SQL.
CREATE TABLE IF NOT EXISTS user_session_cutoffs (
  user_id    UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cutoff_at  TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The read path looks a single row up by primary key, so no further index is
-- needed. This one supports operational queries ("who was revoked recently")
-- and any future pruning of cutoffs older than the longest token lifetime.
CREATE INDEX IF NOT EXISTS user_session_cutoffs_cutoff_at_idx
  ON user_session_cutoffs (cutoff_at DESC);
