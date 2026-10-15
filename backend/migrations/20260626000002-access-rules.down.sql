-- Reverts 20260626000002-access-rules.sql, which is the migration that
-- originally created the access_rules table (tenant_id VARCHAR(50),
-- principal_id VARCHAR(255), plain document_type_id FK) plus its three
-- original indexes.
--
-- Note: a later migration, 20260627000000-access-rules.sql, also touches
-- this same table via CREATE TABLE IF NOT EXISTS (a defensive no-op once
-- this table already exists) and layers on four additional indexes plus
-- table/column comments of its own. That migration's down.sql reverts only
-- those additions and deliberately does NOT drop this table, since it does
-- not own the table's creation. This down.sql is the one responsible for
-- dropping the table itself. Rollbacks run most-recent-first, so by the
-- time this runs, 20260627000000's additions are already gone; DROP TABLE
-- ... CASCADE below is a safety net for any of them that might remain.
DROP INDEX IF EXISTS access_rules_document_type_idx;
DROP INDEX IF EXISTS access_rules_principal_idx;
DROP INDEX IF EXISTS access_rules_tenant_idx;
DROP TABLE IF EXISTS access_rules CASCADE;
