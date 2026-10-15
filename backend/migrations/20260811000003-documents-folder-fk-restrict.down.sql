ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_folder_id_fkey;
ALTER TABLE documents
  ADD CONSTRAINT documents_folder_id_fkey
  FOREIGN KEY (folder_id) REFERENCES folder_nodes(id) ON DELETE SET NULL;
