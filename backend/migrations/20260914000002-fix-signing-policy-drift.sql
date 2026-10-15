-- FIX: requiresSignature and signingPolicy were two independent ways of
-- expressing "does a document of this type need a signing ceremony?" --
-- requiresSignature from day one (checked at upload time and by the older
-- workflow.service.ts completion path), signingPolicy added later for the
-- D8 governance rework (checked only by the newer approvals.service.ts
-- completion path) -- and nothing kept them in sync. Confirmed live: the
-- examplecorp tenant's AGREEMENT/BOARD/CONTRACT types all had
-- requires_signature = TRUE but signing_policy = 'none', so a document of
-- one of those types completing its approval chain through the newer path
-- silently skipped the ceremony its own requires_signature flag said it
-- needed.
--
-- documentTypes.service.ts now derives signingPolicy from requiresSignature
-- on every create/update, so they can't drift apart again. This backfills
-- existing rows to match that invariant.
--
-- Also flips SIGN-UNCAT specifically: it's the fallback type e-signing's
-- direct-upload path files under when no type is picked
-- (esigning.service.ts), and was seeded (both createTenant() and the
-- historical 20260728000001 backfill) with requires_signature = FALSE --
-- backwards for the one type that exists purely to carry e-signed
-- documents, and why signing/page.tsx's e-sign upload document-type picker
-- (now filtered to requires_signature = TRUE types) needs this to include
-- every tenant's own uncategorized bucket.
--
-- document_types has FORCE ROW LEVEL SECURITY, keyed on
-- current_setting('app.current_tenant') (or CURRENT_USER = 'postgres') --
-- a plain tenant-crossing UPDATE with no GUC set silently matches ZERO rows
-- under the app's own restricted DB role (confirmed: this migration was a
-- true no-op the first time it ran against mirror's edams_app connection,
-- while it worked against dev's superuser connection -- exactly the kind of
-- environment-dependent inconsistency this fix is about eliminating, not
-- reproducing). Looping per tenant and setting the GUC before each tenant's
-- statements makes this correct under RLS regardless of which role runs it.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id, true);

    UPDATE document_types
    SET requires_signature = TRUE
    WHERE tenant_id = t.id AND code = 'SIGN-UNCAT' AND requires_signature = FALSE;

    UPDATE document_types
    SET signing_policy = CASE WHEN requires_signature THEN 'ceremony' ELSE 'none' END
    WHERE tenant_id = t.id
      AND signing_policy IS DISTINCT FROM (CASE WHEN requires_signature THEN 'ceremony' ELSE 'none' END);
  END LOOP;
END $$;
