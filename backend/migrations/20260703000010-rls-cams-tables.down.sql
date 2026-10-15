-- Reverts 20260703000010-rls-cams-tables.sql, using the exact down() draft
-- already sketched at the bottom of that file (policy drops in reverse order
-- of creation, then RLS disabled per table in the same reverse order).
--
-- ORDERING NOTE: part of the 7-migration RLS chain (see
-- 20260615000002-rls-policies.down.sql for the full list). This migration's
-- 7 tables (org_units, letters, letter_links, letter_sequences,
-- letter_revisions, letter_approval_steps, letter_dispatches) are disjoint
-- from every other migration in the chain, so this down.sql has no
-- cross-file interaction — it's independently safe to run in isolation.
DROP POLICY IF EXISTS org_units_tenant_isolation ON org_units;
DROP POLICY IF EXISTS letters_tenant_isolation ON letters;
DROP POLICY IF EXISTS letter_links_tenant_isolation ON letter_links;
DROP POLICY IF EXISTS letter_sequences_tenant_isolation ON letter_sequences;
DROP POLICY IF EXISTS letter_revisions_tenant_isolation ON letter_revisions;
DROP POLICY IF EXISTS letter_approval_steps_tenant_isolation ON letter_approval_steps;
DROP POLICY IF EXISTS letter_dispatches_tenant_isolation ON letter_dispatches;

ALTER TABLE org_units DISABLE ROW LEVEL SECURITY;
ALTER TABLE letters DISABLE ROW LEVEL SECURITY;
ALTER TABLE letter_links DISABLE ROW LEVEL SECURITY;
ALTER TABLE letter_sequences DISABLE ROW LEVEL SECURITY;
ALTER TABLE letter_revisions DISABLE ROW LEVEL SECURITY;
ALTER TABLE letter_approval_steps DISABLE ROW LEVEL SECURITY;
ALTER TABLE letter_dispatches DISABLE ROW LEVEL SECURITY;
