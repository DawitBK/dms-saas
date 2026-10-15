-- Reverts 20260704000002-department-org-unit.sql's structural changes: drops
-- the index on department.org_unit_id, then the column itself (which also
-- removes the NOT NULL constraint and every value it held — departments lose
-- their org-unit assignment on the way back down, which is expected since
-- the app code that reads/writes org_unit_id is also being rolled back).
--
-- NOT reversed: the migration's other effect, backfilling a default HQ
-- org_units row for any tenant that didn't already have one (`INSERT INTO
-- org_units ... ON CONFLICT (tenant_id, code) DO NOTHING`). There is no
-- marker distinguishing "an HQ unit this migration created" from "an HQ unit
-- that already existed" — blindly deleting every org_units row with
-- code='HQ' risks deleting a tenant's real, pre-existing head-office record.
-- Leaving a harmless extra org unit in place is far safer than guessing
-- which rows are safe to delete, and org_units rows are otherwise inert
-- (nothing above them in this migration references department rows back).
DROP INDEX IF EXISTS departments_org_unit_idx;
ALTER TABLE departments DROP COLUMN IF EXISTS org_unit_id;
