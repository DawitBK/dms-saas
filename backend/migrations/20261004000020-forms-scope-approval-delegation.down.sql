-- Reverses 20261004000020. Scoped and form-template recipes are DEACTIVATED (not deleted) first so the
-- original one-active-recipe-per-target unique indexes can be rebuilt; the scope columns are then dropped.
-- The 'deprecated' repair of superseded template versions is not undone (those rows were already
-- behaving as superseded). Delegation / escalation history on approval_steps is dropped with its columns.
UPDATE approval_chain_templates SET is_active = false
 WHERE department_id IS NOT NULL OR org_unit_id IS NOT NULL OR for_form_templates;

DROP INDEX IF EXISTS approval_tpl_formtemplates_active_uniq;
DROP INDEX IF EXISTS approval_tpl_doctype_active_uniq;
DROP INDEX IF EXISTS approval_tpl_formtpl_active_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_doctype_active_uniq
  ON approval_chain_templates (tenant_id, document_type_id) WHERE is_active AND document_type_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_formtpl_active_uniq
  ON approval_chain_templates (tenant_id, form_template_id) WHERE is_active AND form_template_id IS NOT NULL;

ALTER TABLE approval_chain_templates DROP CONSTRAINT IF EXISTS approval_chain_templates_one_target;
ALTER TABLE approval_chain_templates DROP CONSTRAINT IF EXISTS approval_chain_templates_not_both_dept_and_org_unit;
ALTER TABLE approval_chain_templates DROP COLUMN IF EXISTS for_form_templates;
ALTER TABLE approval_chain_templates DROP COLUMN IF EXISTS org_unit_id;
ALTER TABLE approval_chain_templates DROP COLUMN IF EXISTS department_id;

DROP INDEX IF EXISTS approval_steps_escalated_to_idx;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS escalated_to_user_ids;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS escalated_at;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS delegation_reason;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS delegated_at;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS delegated_from_role;
ALTER TABLE approval_steps DROP COLUMN IF EXISTS delegated_by;

ALTER TABLE form_instances DROP COLUMN IF EXISTS updated_at;

DROP INDEX IF EXISTS form_templates_org_unit_idx;
DROP INDEX IF EXISTS form_templates_department_idx;
ALTER TABLE form_templates DROP CONSTRAINT IF EXISTS form_templates_not_both_dept_and_org_unit;
ALTER TABLE form_templates DROP COLUMN IF EXISTS org_unit_id;
ALTER TABLE form_templates DROP COLUMN IF EXISTS department_id;
