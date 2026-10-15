/**
 * One-off backfill: filePadesSignedCopy (esigning.service.ts) used to file
 * NOTHING when ESIGN_P12_B64 wasn't configured — a "completed" e-sign
 * ceremony left the document's file completely unchanged, no visible
 * signature anywhere. That's fixed going forward (it now always files a
 * flattened copy, PAdES-embedded or plain depending on whether a
 * certificate is configured), but any request that already completed under
 * the old code needs its flattened copy filed after the fact.
 *
 * Finds every completed signature_requests row across every tenant whose
 * document's current latest version isn't already a filed signed copy
 * (PADES_CHANGE_SUMMARY / FLATTENED_CHANGE_SUMMARY), then calls the same
 * filePadesSignedCopy the completion path calls, inside that request's own
 * tenant context (required under RLS — these are all tenant-scoped tables).
 *
 * Idempotent: filePadesSignedCopy itself already no-ops (without --force)
 * if the latest version is already a filed signed copy, so re-running this
 * script is safe.
 *
 * Usage:
 *   Dev:    npx tsx scripts/backfill-flattened-signed-copies.ts
 *   Mirror: node scripts/run-with-env.cjs mirror npx tsx scripts/backfill-flattened-signed-copies.ts
 */
import '../src/config/env.js';
import { QueryTypes } from 'sequelize';
import { initModels, sequelize, Tenant } from '../src/infrastructure/database/index.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';
import { filePadesSignedCopy } from '../src/modules/esigning/esigning.service.js';
import { PADES_CHANGE_SUMMARY, FLATTENED_CHANGE_SUMMARY } from '../src/modules/esigning/esignPades.js';

type Row = { request_id: string; document_id: string; change_summary: string | null };

async function main() {
  initModels();
  await sequelize.authenticate();
  console.log('Connected to', sequelize.config.database);

  const tenants = await Tenant.findAll({ attributes: ['id'] });
  let checked = 0;
  let filed = 0;

  for (const tenant of tenants) {
    await withWorkerTenantContext(tenant.id, async () => {
      const rows = await sequelize.query<Row>(
        `SELECT sr.id AS request_id, sr.document_id, dv.change_summary
         FROM signature_requests sr
         JOIN documents d ON d.id = sr.document_id
         LEFT JOIN document_versions dv ON dv.id = d.latest_version_id
         WHERE sr.status = 'completed'`,
        { type: QueryTypes.SELECT },
      );
      for (const row of rows) {
        checked++;
        if (row.change_summary === PADES_CHANGE_SUMMARY || row.change_summary === FLATTENED_CHANGE_SUMMARY) continue;
        console.log(`Filing signed copy for request ${row.request_id} (document ${row.document_id}, tenant ${tenant.id})...`);
        await filePadesSignedCopy(row.request_id);
        filed++;
      }
    });
  }

  console.log(`Done. Checked ${checked} completed request(s) across ${tenants.length} tenant(s); filed ${filed} missing signed cop${filed === 1 ? 'y' : 'ies'}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
