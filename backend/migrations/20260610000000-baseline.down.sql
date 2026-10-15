-- Reverts 20260610000000-baseline.sql: drops every core table this baseline
-- created, in exact reverse order of creation (children/dependents before
-- parents), matching the draft `down()` the up-file already sketched in its
-- trailing comment block.
--
-- HIGHEST BLAST RADIUS IN THIS MIGRATION SET: this is the very first
-- migration, so `migrate down` reaching this file means the entire EDAMS
-- schema (users, documents, workflows, audit logs, everything) is gone.
-- Every later migration's own .down.sql is expected to have already run by
-- the time this one does — CASCADE is kept here only as the same safety net
-- the up-file's own draft used, not as a substitute for reverting in order.
--
-- Deliberately NOT dropped: the "SequelizeMeta" table. It is Umzug's own
-- migration-bookkeeping table (this file's up() creates it with `CREATE
-- TABLE IF NOT EXISTS "SequelizeMeta"` precisely because Umzug's
-- SequelizeStorage does not auto-provision it). Umzug records a migration as
-- reverted by writing to this table immediately *after* this down.sql
-- finishes running — if this file dropped it first, that bookkeeping write
-- would fail with "relation does not exist" and `migrate down` would error
-- out on its own last step. Leaving it in place costs nothing: it's an empty
-- single-column table once every migration is reverted, and the next `up`
-- recreates it via `IF NOT EXISTS` regardless.
DROP TABLE IF EXISTS webhook_subscriptions CASCADE;
DROP TABLE IF EXISTS retention_applications CASCADE;
DROP TABLE IF EXISTS purge_pending CASCADE;
DROP TABLE IF EXISTS dept_keys CASCADE;
DROP TABLE IF EXISTS document_deks CASCADE;
DROP TABLE IF EXISTS idempotency_keys CASCADE;
DROP TABLE IF EXISTS saved_searches CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS outbox_events CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS certificates_of_destruction CASCADE;
DROP TABLE IF EXISTS archive_records CASCADE;
DROP TABLE IF EXISTS document_legal_holds CASCADE;
DROP TABLE IF EXISTS legal_holds CASCADE;
DROP TABLE IF EXISTS signature_records CASCADE;
DROP TABLE IF EXISTS workflow_delegations CASCADE;
DROP TABLE IF EXISTS workflow_tasks CASCADE;
DROP TABLE IF EXISTS workflow_instances CASCADE;
DROP TABLE IF EXISTS workflow_definitions CASCADE;
DROP TABLE IF EXISTS doc_locks CASCADE;
DROP TABLE IF EXISTS document_checkouts CASCADE;
DROP TABLE IF EXISTS document_metadata CASCADE;
DROP TABLE IF EXISTS document_versions CASCADE;
DROP TABLE IF EXISTS document_sequences CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS retention_policies CASCADE;
DROP TABLE IF EXISTS document_types CASCADE;
DROP TABLE IF EXISTS folder_nodes CASCADE;
DROP TABLE IF EXISTS user_departments CASCADE;
DROP TABLE IF EXISTS departments CASCADE;
DROP TABLE IF EXISTS auth_sessions CASCADE;
DROP TABLE IF EXISTS user_roles CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP EXTENSION IF EXISTS "pgcrypto";
