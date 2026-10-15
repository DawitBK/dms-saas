-- B5 fix (e-signing audit): signing completion never updated the parent
-- Document. Add a timestamp so downstream views/reports can tell a document
-- has been fully executed via e-signing, independent of any completionAction
-- (e.g. move_folder) side effect.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS fully_signed_at TIMESTAMPTZ;
