-- P1-18: one IdP subject must map to at most one DMS user.
--
-- external_sub was written once at OIDC provisioning time and never read again
-- (the callback matched on email), so nothing stopped two rows carrying the same
-- subject — and the code that now matches on it would silently pick whichever
-- row Postgres returned first. Partial, because most rows are locally-created
-- users with a NULL subject and NULL is not "the same identity" repeated.
--
-- If this fails with a uniqueness violation the data is already ambiguous; find
-- and merge the duplicates before retrying:
--   SELECT external_sub, COUNT(*), array_agg(email) FROM users
--    WHERE external_sub IS NOT NULL GROUP BY external_sub HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS users_external_sub_unique_idx
  ON users (external_sub)
  WHERE external_sub IS NOT NULL;
