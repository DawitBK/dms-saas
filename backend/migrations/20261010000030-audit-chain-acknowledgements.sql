-- An audit hash chain can carry a known, explained, historical break (the development database has one at sequence 476:
-- a row that links to a row that was rolled back by an old, long-fixed race). Rewriting the hashes would destroy the
-- evidence the chain exists to give, so the break stays exactly where it is and is ACKNOWLEDGED instead: a record that
-- names the sequence, the kind of break, who acknowledged it, why, and the stored hashes of the row at that moment.
-- Verification still lists the break; it only stops counting it as an unexplained violation. The acknowledgement is
-- pinned to the row's current entry_hash and previous_hash, so if that row is touched again the acknowledgement no
-- longer applies and the chain reads as broken again. Acknowledging is itself an audit event, appended to the chain.
-- SAFE: brand-new table, nothing depends on it. Deliberately no RLS: the daily verification worker reads every tenant
-- without a tenant context, and the API only ever reads and writes the caller's own tenant.
CREATE TABLE IF NOT EXISTS audit_chain_acknowledgements (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        VARCHAR(100) NOT NULL,
  sequence_number  BIGINT       NOT NULL,
  kind             VARCHAR(10)  NOT NULL CHECK (kind IN ('hash', 'ordering', 'linkage')),
  entry_hash       TEXT         NOT NULL,
  previous_hash    TEXT,
  reason           TEXT         NOT NULL CHECK (char_length(reason) >= 20),
  acknowledged_by  UUID         NOT NULL REFERENCES users(id),
  acknowledged_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sequence_number, kind)
);
CREATE INDEX IF NOT EXISTS audit_chain_ack_tenant_idx ON audit_chain_acknowledgements (tenant_id);
