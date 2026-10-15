-- Wire the existing CAMS OrgUnit hierarchy up as the parent of Department, so
-- the document/folder tree becomes Tenant -> OrgUnit -> Department -> Folder,
-- matching how OrgUnit already sits above Letters in the CAMS module.

-- Some tenants (created via the admin Tenants UI, after the original CAMS
-- foundation migration ran) never got a default HQ unit. Backfill those first
-- so every tenant has at least one org unit before departments attach to one.
INSERT INTO org_units (tenant_id, code, name, unit_type)
SELECT t.id, 'HQ', t.name || ' — Head Office', 'HQ'
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM org_units ou WHERE ou.tenant_id = t.id)
ON CONFLICT (tenant_id, code) DO NOTHING;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS org_unit_id UUID REFERENCES org_units(id);

-- Backfill existing departments onto their tenant's HQ unit (falling back to
-- whichever org unit is oldest if no HQ exists for some reason).
UPDATE departments d
SET org_unit_id = (
  SELECT ou.id FROM org_units ou
  WHERE ou.tenant_id = d.tenant_id
  ORDER BY (ou.unit_type = 'HQ') DESC, ou.created_at ASC
  LIMIT 1
)
WHERE d.org_unit_id IS NULL;

ALTER TABLE departments ALTER COLUMN org_unit_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS departments_org_unit_idx ON departments (org_unit_id);
