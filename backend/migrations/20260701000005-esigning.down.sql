-- Reverts 20260701000005-esigning.sql. Purely additive (three new tables plus
-- their indexes, nothing pre-existing altered), so this drops them in the
-- reverse order they were created. Any signature requests/recipients/fields
-- recorded so far are lost, which is expected: the app code being rolled back
-- to never reads or writes these tables anyway.
DROP INDEX IF EXISTS sig_field_req_idx;
DROP TABLE IF EXISTS signature_fields CASCADE;

DROP INDEX IF EXISTS sig_rec_token_idx;
DROP INDEX IF EXISTS sig_rec_req_idx;
DROP TABLE IF EXISTS signature_recipients CASCADE;

DROP INDEX IF EXISTS sig_req_status_idx;
DROP INDEX IF EXISTS sig_req_doc_idx;
DROP TABLE IF EXISTS signature_requests CASCADE;
