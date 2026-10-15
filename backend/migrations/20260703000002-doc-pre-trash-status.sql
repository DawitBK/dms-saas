-- Phase 2 fix: restoring a trashed document reset it to DRAFT, losing its
-- lifecycle position (an ACTIVE/ARCHIVED doc came back as DRAFT). Capture the
-- pre-trash status so restore can return it. Also normalize the two legacy
-- lowercase statuses to the state-machine vocabulary.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS pre_trash_status VARCHAR(50);

UPDATE documents SET status = 'TRASHED' WHERE status = 'trashed';
UPDATE documents SET status = 'QUARANTINED' WHERE status = 'quarantined';
