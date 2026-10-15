-- SAFE: drops only the table this migration created. Rolling back returns
-- revocation to Redis-only behaviour (the pre-R-04 state), which the code
-- still supports as its cache path — no other table references this one, and
-- nothing else reads it.
DROP TABLE IF EXISTS user_session_cutoffs;
