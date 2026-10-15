#!/usr/bin/env tsx
// Backfill PAdES-flattened signed copies for e-sign ceremonies that completed
// BEFORE ESIGN_P12_B64 was configured in this environment.
//
// filePadesSignedCopy() (esigning.service.ts) only ever runs once, at the
// moment a ceremony transitions to 'completed', gated behind padesConfigured().
// If the cert wasn't set yet, that step is silently skipped (an info-level
// log line, not an error) — the ceremony still completes correctly, but no
// new document version is ever filed, so the recipients' captured signature
// images never actually get drawn onto the PDF. Configuring the cert later
// (or restoring it after this environment lost it) does nothing for
// ceremonies that already completed under the old config — they need this
// one-time backfill. filePadesSignedCopy() itself is idempotent (skips a
// request whose latest version's changeSummary already marks it as filed),
// so this script is safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-pades-signed-copies.ts                (dry run — report only)
//   npx tsx scripts/backfill-pades-signed-copies.ts --execute       (file the missing copies for real)
//   npx tsx scripts/backfill-pades-signed-copies.ts --execute --only-id=<signature_requests.id>
//   npx tsx scripts/backfill-pades-signed-copies.ts --execute --force-id=<signature_requests.id>
//                                                          (regenerate a specific ceremony's flattened
//                                                           copy even if one was already filed — e.g.
//                                                           after fixing a bug in generatePadesSignedPdf.
//                                                           Files a NEW version from the original base
//                                                           document, it does not touch/delete the old
//                                                           one, so version history stays append-only.)

import { sequelize, initModels, SignatureRequest, DocumentVersion, Document } from "../src/infrastructure/database/index.js";
import { padesConfigured } from "../src/modules/esigning/esignPades.js";
import { filePadesSignedCopy } from "../src/modules/esigning/esigning.service.js";
import { logger } from "../src/core/logger.js";
import { withWorkerTenantContext } from "../src/shared/workerTenantContext.js";
import { QueryTypes } from "sequelize";

const PADES_CHANGE_SUMMARY = "E-sign: PAdES-signed flattened copy (certificate of completion appended)";

// FIX 2026-09-23: signature_requests has no RLS, but `documents` FORCE-enables
// it with a strict tenant_id-match policy and no fail-open clause — every
// Document.findByPk in this file (including inside filePadesSignedCopy
// itself, which also has no context of its own — it normally runs embedded
// in an authenticated request's ambient transaction) ran with no
// app.current_tenant ever set, so it always returned null under the app's
// real (non-superuser) DB role, and every candidate got silently skipped via
// `if (!doc?.latestVersionId) continue`. This script has never found a real
// candidate in production regardless of how many completed ceremonies were
// actually missing their flattened copy. Since a signature_requests row
// doesn't carry its own tenant_id, resolve it via its document, scoped per
// tenant — same technique used to fix the letters/verify public route.
async function resolveTenants(): Promise<string[]> {
  const rows = await sequelize.query<{ id: string }>("SELECT id FROM tenants", { type: QueryTypes.SELECT });
  return rows.map((r) => r.id);
}

/** Returns the tenant a document belongs to, or null if not found in any. */
async function resolveDocumentTenant(documentId: string, tenants: string[]): Promise<string | null> {
  for (const tenantId of tenants) {
    const found = await withWorkerTenantContext(tenantId, () => Document.findByPk(documentId, { attributes: ["id"] }));
    if (found) return tenantId;
  }
  return null;
}

async function findCandidates(onlyId?: string): Promise<Array<{ requestId: string; tenantId: string }>> {
  const requests = await SignatureRequest.findAll({
    where: onlyId ? { id: onlyId, status: "completed" } : { status: "completed" },
    attributes: ["id", "documentId"],
  });
  const tenants = await resolveTenants();

  const candidates: Array<{ requestId: string; tenantId: string }> = [];
  for (const req of requests) {
    for (const tenantId of tenants) {
      // null = document not in this tenant, keep searching; boolean = found,
      // stop searching (whether or not it's actually a candidate).
      const result = await withWorkerTenantContext(tenantId, async (): Promise<boolean | null> => {
        const doc = await Document.findByPk(req.documentId, { attributes: ["latestVersionId"] });
        if (!doc) return null;
        if (!doc.latestVersionId) return false;
        const currentVersion = await DocumentVersion.findByPk(doc.latestVersionId, { attributes: ["changeSummary"] });
        return currentVersion?.changeSummary !== PADES_CHANGE_SUMMARY; // not already filed
      });
      if (result === null) continue;
      if (result === true) candidates.push({ requestId: req.id, tenantId });
      break;
    }
  }
  return candidates;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const onlyIdArg = args.find((a) => a.startsWith("--only-id="));
  const onlyId = onlyIdArg ? onlyIdArg.slice("--only-id=".length) : undefined;
  const forceIdArg = args.find((a) => a.startsWith("--force-id="));
  const forceId = forceIdArg ? forceIdArg.slice("--force-id=".length) : undefined;

  try {
    await sequelize.authenticate();
    initModels();
    logger.info("Database connection established");

    if (!padesConfigured()) {
      console.error("ESIGN_P12_B64 is not configured — nothing to backfill onto. Set it and re-run.");
      await sequelize.close();
      process.exit(1);
    }

    if (forceId) {
      if (!execute) {
        console.log(`Dry run — pass --execute to regenerate ${forceId}.`);
        await sequelize.close();
        process.exit(0);
      }
      try {
        const req = await SignatureRequest.findByPk(forceId, { attributes: ["documentId"] });
        if (!req) throw new Error(`signature_requests row ${forceId} not found`);
        const tenants = await resolveTenants();
        const tenantId = await resolveDocumentTenant(req.documentId, tenants);
        if (!tenantId) throw new Error(`document ${req.documentId} not found in any tenant`);
        await withWorkerTenantContext(tenantId, () => filePadesSignedCopy(forceId, { force: true }));
        console.log(`  ✓ regenerated: ${forceId}`);
        await sequelize.close();
        process.exit(0);
      } catch (error) {
        logger.error({ error, requestId: forceId }, "backfill: failed to regenerate signed copy");
        console.log(`  ✗ failed: ${forceId}`);
        await sequelize.close();
        process.exit(1);
      }
    }

    const candidates = await findCandidates(onlyId);
    console.log(`Found ${candidates.length} completed ceremony(ies) missing a flattened signed copy.`);

    if (!execute) {
      console.log("Dry run — pass --execute to file the missing copies.");
      for (const c of candidates) console.log(`  would file: ${c.requestId} (tenant ${c.tenantId})`);
      await sequelize.close();
      process.exit(0);
    }

    let filed = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        await withWorkerTenantContext(c.tenantId, () => filePadesSignedCopy(c.requestId));
        filed++;
        console.log(`  ✓ filed: ${c.requestId}`);
      } catch (error) {
        failed++;
        logger.error({ error, requestId: c.requestId }, "backfill: failed to file signed copy");
        console.log(`  ✗ failed: ${c.requestId}`);
      }
    }

    console.log(`\nDone. Filed: ${filed}, Failed: ${failed}.`);
    await sequelize.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    logger.error({ error }, "Backfill failed");
    await sequelize.close();
    process.exit(1);
  }
}

main();
