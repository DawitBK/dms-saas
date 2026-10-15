-- Reverts 20260629000001-document-comments.sql. Purely additive table +
-- indexes; dropping the table removes all of it. Any comments/annotations
-- authored on documents since are lost, which is expected on rollback.
DROP INDEX IF EXISTS idx_document_comments_parent;
DROP INDEX IF EXISTS idx_document_comments_tenant;
DROP INDEX IF EXISTS idx_document_comments_document;
DROP TABLE IF EXISTS document_comments CASCADE;
