import { MeiliSearch } from 'meilisearch';
import { config } from '../../config/env.js';
import { logger } from '../../core/logger.js';

export const meili = config.MEILISEARCH_HOST
  ? new MeiliSearch({ host: config.MEILISEARCH_HOST, apiKey: config.MEILISEARCH_MASTER_KEY })
  : null;

export async function ensureMeilisearchHealthy(): Promise<void> {
  if (!meili) return;
  try {
    await meili.health();
    logger.info('meilisearch healthy');
  } catch (error) {
    logger.warn({ error }, 'meilisearch unavailable; search degraded');
  }
}

export async function ensureTenantSearchIndex(tenantId: string): Promise<void> {
  if (!meili) return;
  const indexName = `edms-docs-${tenantId}`;
  try {
    try {
      await meili.getIndex(indexName);
    } catch {
      await meili.createIndex(indexName, { primaryKey: 'id' });
    }
    const index = meili.index(indexName);
    await index.updateSearchableAttributes(['title', 'documentName', 'extractedText', 'keywords', 'description']);
    await index.updateFilterableAttributes([
      // departmentId is the precise, collision-free filter (department codes
      // are only unique per org unit as of migration
      // 20260912000001-department-code-scope-org-unit.sql, so two departments
      // in different org units can share a code). departmentCode stays
      // filterable too, only so existing saved searches serialized before
      // this change keep working — new filtering should always use
      // departmentId. See search.service.ts's SearchFilters comment.
      'tenantId', 'status', 'securityClassification', 'retentionClass',
      'isOnLegalHold', 'ownerId', 'departmentId', 'departmentCode', 'documentTypeCode'
    ]);
    await index.updateSortableAttributes(['createdAt', 'updatedAt', 'title']);
  } catch (error) {
    logger.warn({ error, indexName }, 'failed to configure tenant search index');
  }
}
