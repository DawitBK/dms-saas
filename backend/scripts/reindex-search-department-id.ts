/**
 * Backfill `departmentId` into every already-indexed Meilisearch document,
 * and force each tenant's index settings to declare it filterable.
 *
 * WHY THIS EXISTS
 *
 * The search index (SearchWorker.ts) only ever indexed `departmentCode`, and
 * filtering/faceting (search.service.ts, meilisearch.ts) was built entirely
 * on that string. Department codes used to be unique tenant-wide, but
 * migration 20260912000001-department-code-scope-org-unit.sql widened
 * uniqueness to (tenant, org unit) — so two departments in different org
 * units can now share a code, and a department-code filter/facet can no
 * longer tell them apart. `departmentId` was added as the precise,
 * collision-free field (SearchWorker.ts now indexes it on every new/updated
 * document; search.service.ts/meilisearch.ts now filter/facet on it,
 * resolving a legacy `departmentCode` to every matching department id for
 * backward compatibility with old saved searches).
 *
 * That only fixes documents indexed AFTER this change. Every document
 * indexed before it is missing `departmentId` in Meilisearch until
 * re-indexed — this script does that: for each tenant, re-push
 * `updateFilterableAttributes` (so departmentId is queryable immediately
 * rather than waiting for SearchWorker's 1h settings cache) and re-add every
 * active document's search payload with its current departmentId.
 *
 * Idempotent: `addDocuments` upserts by primary key (`id`), so re-running
 * this simply re-writes the same rows.
 *
 * Usage:
 *   npx tsx scripts/reindex-search-department-id.ts            # dry run
 *   npx tsx scripts/reindex-search-department-id.ts --execute  # apply
 */

import 'dotenv/config';
import {
  connectDB,
  initModels,
  sequelize,
  Document,
  Department,
  DocumentType,
  DocumentMetadata,
  DocumentVersion,
  Tenant,
} from '../src/infrastructure/database/index.js';
import { meili, ensureTenantSearchIndex } from '../src/infrastructure/search/meilisearch.js';
import { withWorkerTenantContext } from '../src/shared/workerTenantContext.js';

const EXECUTE = process.argv.includes('--execute');
const BATCH_SIZE = 200;

async function main() {
  initModels();
  await connectDB();

  if (!meili) {
    console.log('\n  Meilisearch is not configured (MEILISEARCH_HOST unset) — nothing to reindex.\n');
    await sequelize.close();
    process.exit(0);
  }

  const tenants = await Tenant.findAll({ attributes: ['id', 'name'] });
  console.log(`\n  tenants found: ${tenants.length}`);

  // FIX 2026-09-23: `documents` FORCE-enables RLS with a strict tenant_id-
  // match policy and no fail-open clause. Every Document query below ran with
  // no app.current_tenant ever set, so this always counted (and later
  // batch-fetched) zero documents per tenant under the app's real
  // (non-superuser) DB role — this script has always reported "TOTAL
  // documents to reindex: 0" regardless of actual document count. Scope every
  // per-tenant query with withWorkerTenantContext, same fix already applied
  // elsewhere this session.
  let totalDocs = 0;
  const perTenantCounts: { tenantId: string; name: string; count: number }[] = [];

  for (const tenant of tenants) {
    const count = await withWorkerTenantContext(tenant.id, () =>
      Document.count({ where: { tenantId: tenant.id, deletedAt: null } }),
    );
    perTenantCounts.push({ tenantId: tenant.id, name: tenant.name, count });
    totalDocs += count;
  }

  for (const t of perTenantCounts) {
    console.log(`    ${t.name} (${t.tenantId}): ${t.count} document(s)`);
  }
  console.log(`  TOTAL documents to reindex: ${totalDocs}\n`);

  if (!EXECUTE) {
    console.log('  DRY RUN — re-run with --execute to apply.\n');
    await sequelize.close();
    process.exit(0);
  }

  let reindexed = 0;
  for (const tenant of tenants) {
    // Force the settings push now rather than waiting for SearchWorker's own
    // 1h ensureTenantIndexCached TTL — otherwise departmentId isn't actually
    // filterable yet even after the documents below carry it.
    await ensureTenantSearchIndex(tenant.id);
    const indexName = `edms-docs-${tenant.id}`;

    let offset = 0;
    for (;;) {
      const batch = await withWorkerTenantContext(tenant.id, () =>
        Document.findAll({
          where: { tenantId: tenant.id, deletedAt: null },
          include: [
            { model: Department, as: 'department' },
            { model: DocumentType, as: 'documentType' },
            { model: DocumentMetadata, as: 'metadata' },
            { model: DocumentVersion, as: 'versions', limit: 1, order: [['createdAt', 'DESC']] },
          ],
          limit: BATCH_SIZE,
          offset,
          order: [['id', 'ASC']],
        }),
      );
      if (batch.length === 0) break;

      const payload = batch.map((document) => {
        const dept = (document as any).department;
        const docType = (document as any).documentType;
        const latestVersion = (document as any).versions?.[0];
        const metadata = (document as any).metadata;
        return {
          id: document.id,
          tenantId: document.tenantId,
          documentName: document.documentName,
          title: document.title,
          departmentId: document.departmentId,
          departmentCode: dept?.code,
          documentTypeCode: docType?.code,
          status: document.status,
          securityClassification: document.securityClassification,
          retentionClass: document.retentionClass,
          isOnLegalHold: document.isOnLegalHold,
          ownerId: document.ownerId,
          organisationUnit: document.organisationUnit,
          keywords: metadata?.keywords,
          description: metadata?.description,
          extractedText: latestVersion?.extractedText,
          createdAt: document.createdAt.getTime(),
          updatedAt: document.updatedAt.getTime(),
          archivedAt: document.archivedAt?.getTime(),
        };
      });

      await meili.index(indexName).addDocuments(payload);
      reindexed += payload.length;
      offset += BATCH_SIZE;
      console.log(`    ${tenant.name}: reindexed ${Math.min(offset, perTenantCounts.find((t) => t.tenantId === tenant.id)?.count ?? offset)}/${perTenantCounts.find((t) => t.tenantId === tenant.id)?.count ?? '?'}`);
    }
  }

  console.log(`\n  reindexed ${reindexed} document(s) across ${tenants.length} tenant(s).\n`);
  await sequelize.close();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n  reindex failed:', error);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
