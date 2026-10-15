-- Form reference numbers are unique PER TENANT, like letter reference numbers, not across the whole database.
--
-- The counter behind a number is per tenant, organisation unit and year, and the number (REF/<unit>/<department>/FORM/<year>/<n>) does not name the tenant, so the first form
-- approved in a SECOND tenant whose unit and department codes match an existing one (HQ and FIN) got the same string as the first tenant's form. The old index
-- (form_instances_reference_number_key) is unique across every tenant, so the insert failed; the allocator swallowed the error inside the approval's transaction, which left that transaction
-- aborted, and the approval ended as a 500. Letters never had the problem: letters_tenant_ref_uniq is (tenant_id, reference_number).
--
-- form_instances has no tenant column, so the tenant the number was allocated for is recorded beside it (reference_tenant_id), set in the same statement as the number, and the unique index
-- is (reference_tenant_id, reference_number). Rows that already carry a number get their tenant from their template.
--
-- Additive and safe: a nullable column, a backfill of the numbered rows only, and an index swap in one transaction. Old code that does not know the column keeps working (it never writes a
-- number without going through the allocator, which this release updates).

ALTER TABLE form_instances ADD COLUMN IF NOT EXISTS reference_tenant_id TEXT;

UPDATE form_instances fi
   SET reference_tenant_id = ft.tenant_id
  FROM form_templates ft
 WHERE ft.id = fi.template_id
   AND fi.reference_number IS NOT NULL
   AND fi.reference_tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS form_instances_tenant_ref_uniq
  ON form_instances (reference_tenant_id, reference_number)
  WHERE reference_number IS NOT NULL;

DROP INDEX IF EXISTS form_instances_reference_number_key;
