-- Reverts 20260627000000-access-rules.sql, the follow-up migration to
-- 20260626000002-access-rules.sql. This migration's own CREATE TABLE IF NOT
-- EXISTS was a defensive no-op (the table was already created by
-- 20260626000002), so its real payload — and the only thing this down.sql
-- undoes — is the four extra lookup indexes and the table/column comments
-- it added on top of the existing table.
--
-- Deliberately does NOT DROP TABLE access_rules: this migration does not own
-- the table's creation (20260626000002 does), and dropping it here would
-- reach across into that other migration's ownership. See that migration's
-- down.sql for the table drop.
COMMENT ON COLUMN access_rules.effect IS NULL;
COMMENT ON COLUMN access_rules.document_type_id IS NULL;
COMMENT ON TABLE access_rules IS NULL;

DROP INDEX IF EXISTS idx_access_rules_expires;
DROP INDEX IF EXISTS idx_access_rules_tenant_wide;
DROP INDEX IF EXISTS idx_access_rules_document_type;
DROP INDEX IF EXISTS idx_access_rules_principal;
