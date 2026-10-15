-- Reverses 20261013000010: the number is unique across every tenant again. This fails if two tenants already hold the same number (which is what the migration allowed);
-- renumber one of them first. The column stays: it is harmless without the index.
DROP INDEX IF EXISTS form_instances_tenant_ref_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS form_instances_reference_number_key
  ON form_instances (reference_number)
  WHERE reference_number IS NOT NULL;
