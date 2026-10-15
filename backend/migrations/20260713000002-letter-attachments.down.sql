-- Reverts 20260713000002-letter-attachments.sql. Safe: this is a brand new
-- table with no other table referencing it — dropping it loses whatever
-- supplementary attachments were uploaded (their underlying `documents` rows
-- are untouched, only the link record disappears), which is the expected
-- behavior for rolling back the feature that created the link in the first
-- place.
DROP POLICY IF EXISTS letter_attachments_tenant_isolation ON letter_attachments;
ALTER TABLE IF EXISTS letter_attachments DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS letter_attachments;
