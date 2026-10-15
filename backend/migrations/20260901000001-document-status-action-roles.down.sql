-- Reverts 20260901000001-document-status-action-roles.sql. Purely additive
-- table + index + RLS policy, so a straight drop undoes it cleanly; any rows
-- inserted since are lost, which is expected on rollback.
DROP POLICY IF EXISTS document_status_action_roles_tenant_isolation ON document_status_action_roles;
DROP INDEX IF EXISTS doc_status_action_roles_lookup_idx;
DROP TABLE IF EXISTS document_status_action_roles CASCADE;
