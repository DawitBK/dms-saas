-- Reverts 20260619000000-create-tenants.sql. tenants was a brand-new table
-- (including the seeded 'examplecorp' dev-tenant row, which disappears along
-- with the table — expected, it's reseeded by this same migration if re-run).
-- CASCADE is required because later migrations add tenant_id foreign keys
-- into this table (e.g. user_tenants, forms-engine, document_bundles,
-- legal_holds) — those FK constraints are dropped along with tenants, not
-- the child tables themselves.
DROP TABLE IF EXISTS tenants CASCADE;
