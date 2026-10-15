-- Reverts 20260702000001-cams-foundation.sql. Drops the whole CAMS Phase 1
-- schema (org_units, letters, letter_sequences, letter_revisions,
-- letter_approval_steps, letter_links, letter_dispatches) in the reverse
-- order they were created, so each DROP TABLE runs before any table it
-- references is removed. This is purely additive new schema, so nothing
-- outside CAMS depends on it; every letter/correspondence record and org
-- unit (including the seeded per-tenant HQ rows) is lost on rollback, which
-- is expected since the app code being rolled back to never reads any of
-- this.
DROP INDEX IF EXISTS letter_dispatches_letter_idx;
DROP TABLE IF EXISTS letter_dispatches CASCADE;

DROP INDEX IF EXISTS letter_links_related_idx;
DROP TABLE IF EXISTS letter_links CASCADE;

DROP INDEX IF EXISTS letter_steps_pending_idx;
DROP INDEX IF EXISTS letter_steps_letter_idx;
DROP TABLE IF EXISTS letter_approval_steps CASCADE;

DROP TABLE IF EXISTS letter_revisions CASCADE;

DROP TABLE IF EXISTS letter_sequences CASCADE;

DROP INDEX IF EXISTS letters_document_idx;
DROP INDEX IF EXISTS letters_tenant_year_idx;
DROP INDEX IF EXISTS letters_tenant_dir_status_idx;
DROP INDEX IF EXISTS letters_tenant_unit_idx;
DROP INDEX IF EXISTS letters_tenant_ref_uniq;
DROP TABLE IF EXISTS letters CASCADE;

DROP INDEX IF EXISTS org_units_tenant_idx;
DROP TABLE IF EXISTS org_units CASCADE;
