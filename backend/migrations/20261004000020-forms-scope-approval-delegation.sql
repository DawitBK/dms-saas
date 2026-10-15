-- Forms / approval engine follow-ups (module audit 2026-10-04, items E1, E6, E7 and finding #23).
--
-- 1. form_templates.department_id / org_unit_id: a template may now be scoped like a document type
--    (department = that department only; org unit = every department under it; both NULL = whole
--    tenant, which is what every existing row keeps). Plain FKs (NO ACTION) on purpose: hard-deleting
--    a department must not silently widen a scoped template to the whole tenant.
-- 2. approval_chain_templates: the same scope columns (a recipe can differ per department / org unit)
--    plus for_form_templates (a recipe for APPROVING form templates themselves, which had none). The
--    one-active-recipe-per-target unique indexes now include the scope.
-- 3. approval_steps: delegation (who handed the step over, from which role, when, why) and escalation
--    (when it escalated and to whom; those users may decide the step alongside the assignee).
-- 4. form_instances.updated_at: set when the filer edits a form before approval.
-- 5. Repair: a template version that was activated while an older active version of the same name
--    existed left both 'active' (the engine never deprecated the old one). The older ones are already
--    treated as superseded everywhere (SUPERSEDED_SQL); mark them deprecated for real.
-- SAFE: additive nullable columns / defaults; index swap is equivalent for existing rows (all scope
-- columns NULL); the repair only changes rows that were already behaving as superseded.

ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id);
ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id);
DO $$ BEGIN
  ALTER TABLE form_templates ADD CONSTRAINT form_templates_not_both_dept_and_org_unit
    CHECK (NOT (department_id IS NOT NULL AND org_unit_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS form_templates_department_idx ON form_templates (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS form_templates_org_unit_idx ON form_templates (org_unit_id) WHERE org_unit_id IS NOT NULL;

ALTER TABLE approval_chain_templates ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id);
ALTER TABLE approval_chain_templates ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id);
ALTER TABLE approval_chain_templates ADD COLUMN IF NOT EXISTS for_form_templates boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  ALTER TABLE approval_chain_templates ADD CONSTRAINT approval_chain_templates_not_both_dept_and_org_unit
    CHECK (NOT (department_id IS NOT NULL AND org_unit_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE approval_chain_templates ADD CONSTRAINT approval_chain_templates_one_target
    CHECK (NOT (for_form_templates AND num_nonnulls(document_type_id, form_template_id) > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP INDEX IF EXISTS approval_tpl_doctype_active_uniq;
DROP INDEX IF EXISTS approval_tpl_formtpl_active_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_doctype_active_uniq
  ON approval_chain_templates (tenant_id, document_type_id,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active AND document_type_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_formtpl_active_uniq
  ON approval_chain_templates (tenant_id, form_template_id,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active AND form_template_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_formtemplates_active_uniq
  ON approval_chain_templates (tenant_id,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active AND for_form_templates;

ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS delegated_by uuid REFERENCES users(id);
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS delegated_from_role varchar(100);
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS delegated_at timestamptz;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS delegation_reason text;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE approval_steps ADD COLUMN IF NOT EXISTS escalated_to_user_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS approval_steps_escalated_to_idx ON approval_steps USING gin (escalated_to_user_ids)
  WHERE status = 'PENDING';

ALTER TABLE form_instances ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE form_templates t
SET status = 'deprecated', updated_at = now()
WHERE t.status = 'active'
  AND EXISTS (
    SELECT 1 FROM form_templates newer
    WHERE newer.tenant_id = t.tenant_id AND newer.name = t.name
      AND newer.status = 'active' AND newer.version > t.version
  );
