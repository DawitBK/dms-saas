-- Reverses 20261010000020. Default recipes are DEACTIVATED (not deleted) so no history is lost.
UPDATE approval_chain_templates SET is_active = false
 WHERE document_type_id IS NULL AND form_template_id IS NULL AND NOT for_form_templates;
DROP INDEX IF EXISTS approval_tpl_default_active_uniq;
