-- Reference numbers for approved form instances.
--
-- Reported as "the forms module needs to have department etc as the rest,
-- otherwise how can it have a ref number". The department and org unit turned
-- out to be derivable already (a form's backing document carries departmentId,
-- and departments.org_unit_id is NOT NULL), so the only genuinely missing
-- pieces were a counter and somewhere to keep the allocated number.
--
-- Shape deliberately mirrors letter_sequences (20260702000001-cams-foundation
-- .sql): a gap-free counter keyed per tenant + org unit + year, locked FOR
-- UPDATE at allocation time. Same guarantees, same failure modes, same thing to
-- reason about — a records officer auditing a gap in either series is looking
-- at the same mechanism.
--
-- SEPARATE from letter_sequences, not a new letter_type on it. Sharing would
-- have put forms and letters in one numbering space per org unit, so a form
-- filed between two letters would visibly consume a number in the
-- correspondence series. That is very hard to unpick once numbers are printed
-- on documents people have filed, and the two series answer to different
-- registers.

CREATE TABLE IF NOT EXISTS form_sequences (
  tenant_id   VARCHAR(100) NOT NULL,
  org_unit_id UUID         NOT NULL REFERENCES org_units(id),
  year        INTEGER      NOT NULL,
  last_value  INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, org_unit_id, year)
);

-- Allocated at FINAL APPROVAL, never at submit.
--
-- A number allocated at submit is consumed by every declined or abandoned
-- submission, so the series develops gaps in normal use — which defeats the
-- point of a gap-free counter and makes a genuine gap unnoticeable. Letters
-- allocate at signature for exactly this reason; forms allocate at the
-- equivalent moment in their own lifecycle.
--
-- Nullable because most rows will never have one: a template with
-- instance_approval = 'none' files an instance that is never approved and so is
-- never numbered.
ALTER TABLE form_instances
  ADD COLUMN IF NOT EXISTS reference_number TEXT,
  ADD COLUMN IF NOT EXISTS reference_allocated_at TIMESTAMPTZ;

-- One number, one form. A partial unique index rather than a plain UNIQUE
-- constraint so the many un-numbered rows do not all have to be distinct NULLs
-- (they would be, but the partial index is smaller and states the intent).
CREATE UNIQUE INDEX IF NOT EXISTS form_instances_reference_number_key
  ON form_instances (reference_number)
  WHERE reference_number IS NOT NULL;
