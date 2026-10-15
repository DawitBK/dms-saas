-- SAFE: drops only the column and index this migration added. Rolling back
-- collapses every shard back into one chain per tenant, which is the pre-R-02
-- behaviour. Note for whoever runs this: rows written to shards 1..N-1 while
-- the column existed become part of a single per-tenant chain again, and their
-- previousHash linkage will NOT be contiguous in that collapsed view — so
-- verifyAuditChain will report linkage breaks at each former shard boundary.
-- Those are an artefact of the rollback, not tampering. Roll back only with
-- AUDIT_CHAIN_SHARDS already set back to 1 and that consequence understood.
DROP INDEX IF EXISTS audit_logs_tenant_shard_seq_idx;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS chain_shard;
