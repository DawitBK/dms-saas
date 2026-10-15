-- A catch-all ("default") approval recipe: a recipe that targets NO document type, NO form template and is not
-- the approval of form templates. It applies to everything submitted at its scope (department, organisation unit
-- or the whole tenant) that has no recipe of its own, so an organisation unit can name its default approver
-- instead of every unconfigured document falling back to the department manager.
-- At most one active default per scope. Additive: no existing row matches the predicate (every existing recipe
-- targets a document type, a form template or form-template approval), so existing behaviour is unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS approval_tpl_default_active_uniq
  ON approval_chain_templates (tenant_id,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active AND document_type_id IS NULL AND form_template_id IS NULL AND NOT for_form_templates;
