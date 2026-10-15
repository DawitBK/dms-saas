-- AUDIT-FINDINGS-2026-07-26.md #12: documents.folder_id was the one FK in
-- this table's own set using ON DELETE SET NULL (20260610000000-baseline.sql
-- line 115) while department_id/document_type_id/owner_id all default to
-- RESTRICT. Deleting a folder would silently detach every document inside it
-- (no audit trail, no block) instead of being hard-blocked like deleting a
-- department/doc-type/user is.
--
-- In practice DELETE /folders/:id (folders.routes.ts) only ever calls
-- deactivateFolder (a soft isActive=false flip) — nothing in this codebase
-- issues a real `DELETE FROM folder_nodes`, so this FK's ON DELETE clause has
-- never actually fired. Aligning it to RESTRICT is a zero-risk consistency
-- fix today and a real safety net if a hard-delete path is ever added later:
-- it will fail loudly instead of silently orphaning documents from their
-- folder context.
ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_folder_id_fkey;
ALTER TABLE documents
  ADD CONSTRAINT documents_folder_id_fkey
  FOREIGN KEY (folder_id) REFERENCES folder_nodes(id) ON DELETE RESTRICT;
