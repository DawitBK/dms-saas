-- Reverts 20260703000003-letters-indexes.sql. Safe: these were all
-- performance-only indexes (covering btree + trigram GIN) added on top of
-- the existing letters table — nothing depends on an index existing at the
-- database level, only on the underlying data, which is untouched. Dropping
-- them just returns letters listing/search to its pre-migration (slower)
-- query plans.
DROP INDEX IF EXISTS letters_correspondent_trgm_idx;
DROP INDEX IF EXISTS letters_reference_trgm_idx;
DROP INDEX IF EXISTS letters_subject_trgm_idx;
DROP INDEX IF EXISTS letters_due_date_idx;
DROP INDEX IF EXISTS letters_tenant_updated_idx;
DROP INDEX IF EXISTS letters_tenant_assigned_idx;
DROP INDEX IF EXISTS letters_tenant_created_by_idx;
DROP INDEX IF EXISTS letters_tenant_dept_updated_idx;
