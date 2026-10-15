-- Reverses 20261011000010. The label is writable independently again; the labels repaired by the migration stay repaired (they were wrong, so there is nothing to restore).
DROP TRIGGER IF EXISTS documents_sync_sensitivity_label ON documents;
DROP FUNCTION IF EXISTS documents_sync_sensitivity_label();
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_security_classification_check;
