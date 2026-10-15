-- Reverses the SIGN-UNCAT-specific flip only. The general signing_policy
-- reconciliation isn't reversed: which rows had it manually diverged before
-- this migration ran isn't recoverable, and the deployed application code
-- (documentTypes.service.ts) recomputes signing_policy from
-- requires_signature on every future save regardless, so leaving already-
-- reconciled rows alone after a rollback doesn't reintroduce the drift this
-- migration fixed.
--
-- Looped per tenant for the same RLS reason as the up migration -- see its
-- comment.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id, true);

    UPDATE document_types
    SET requires_signature = FALSE, signing_policy = 'none'
    WHERE tenant_id = t.id AND code = 'SIGN-UNCAT' AND requires_signature = TRUE;
  END LOOP;
END $$;
