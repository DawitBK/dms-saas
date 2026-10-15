-- DATA-3: the API and worker are separate OS processes in every real
-- deployment (production-start.bat starts them as two windows specifically
-- so a native crash inside worker code can't take the API down with it —
-- see its own comment, 2026-08-28). That means an in-process flag in
-- workers/index.ts is invisible to the API process that serves
-- /operations/health: it would always read "never started" there even when
-- the worker process is perfectly healthy. A durable, cross-process signal
-- is needed, and Postgres is the right channel — it's required
-- infrastructure regardless of Redis state, unlike Redis itself, which is
-- exactly the thing that can be down when this matters most.
--
-- Single-row singleton table (id is always 'worker'), touched at boot and
-- re-touched periodically while the worker process is alive, so a later
-- silent crash of the whole worker process is also observable (not just a
-- boot-time failure) — closing the "no ongoing health signal" half of the
-- finding, not only the "no retry" half.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
