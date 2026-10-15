-- Org units are flat siblings under the tenant (HQ, branches, outlets, sister
-- companies) — never nested inside one another. That nesting was allowed by
-- the API and accidentally exercised by test-data creation (verify-cams.ts
-- created "Test Branch" units under HQ on every run, with no cleanup),
-- making the hierarchy tree show branches as children of HQ instead of its
-- siblings. The API no longer accepts parent_unit_id (see orgUnits.routes.ts);
-- this migration flattens any org unit that was nested under this fix.
UPDATE org_units SET parent_unit_id = NULL WHERE parent_unit_id IS NOT NULL;
