-- Maker–checker on manual purges (SYSTEM-DECISIONS.md D12): record WHO staged
-- a purge so approval can be refused to the same person. Nullable — rows
-- created by the automated trash flow before this migration have no known
-- stager.
ALTER TABLE purge_pending ADD COLUMN IF NOT EXISTS staged_by_id UUID NULL;
