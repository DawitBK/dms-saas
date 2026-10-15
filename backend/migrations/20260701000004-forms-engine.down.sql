-- Reverts 20260701000004-forms-engine.sql. Drops form_instances before
-- form_templates since the former references the latter by FK. Purely
-- additive tables/indexes, so a straight drop is safe; any authored form
-- templates and completed form instances are lost on the way back down,
-- which is expected for a rollback of the migration that created these
-- tables in the first place.
DROP INDEX IF EXISTS form_instances_document_idx;
DROP INDEX IF EXISTS form_instances_template_idx;
DROP TABLE IF EXISTS form_instances CASCADE;

DROP INDEX IF EXISTS form_templates_status_idx;
DROP INDEX IF EXISTS form_templates_tenant_idx;
DROP TABLE IF EXISTS form_templates CASCADE;
