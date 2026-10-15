ALTER TABLE letter_attachments DROP CONSTRAINT IF EXISTS letter_attachments_document_id_fkey;
ALTER TABLE letter_attachments
  ADD CONSTRAINT letter_attachments_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES documents(id);
