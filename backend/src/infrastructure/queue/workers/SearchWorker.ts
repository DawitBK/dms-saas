import { Worker, Job } from "bullmq";
import { getRedis } from "../../cache/redis.js";
import { Department, Document, DocumentMetadata, DocumentType, DocumentVersion } from "../../database/index.js";
import { logger } from "../../../core/logger.js";
import { meili, ensureTenantSearchIndex } from "../../search/meilisearch.js";
import { withWorkerTenantContext } from "../../../shared/workerTenantContext.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

// TEN-1: every producer now stamps payload.tenantId (matching OCR_PROCESSING's
// existing convention) — Document reads are RLS-protected, and with no
// `app.current_tenant` GUC set an unscoped read either returns 0 rows (a
// hardened, non-superuser DB role — the production case) or every tenant's
// rows unfiltered (a superuser/BYPASSRLS role — dev/test). Wrap in tenant
// context whenever the job carries one; fall back unwrapped only for a
// legacy-shaped job enqueued before this field existed (matches OCRWorker's
// own documented fallback for the same reason).
const inTenantCtx = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  tenantId ? withWorkerTenantContext(tenantId, fn) : fn();

// Cache known-good tenant indexes to avoid 3 Meilisearch API calls per document
const indexedTenants = new Map<string, number>();
const INDEX_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function ensureTenantIndexCached(tenantId: string): Promise<void> {
  const cached = indexedTenants.get(tenantId);
  if (cached && Date.now() - cached < INDEX_CACHE_TTL_MS) return;
  await ensureTenantSearchIndex(tenantId);
  indexedTenants.set(tenantId, Date.now());
}

export async function createSearchWorker() {
  const connection = getRedis();
  if (!connection || !meili) return;

  const worker = new Worker(
    "SEARCH_INDEX",
    async (job: Job) => {
      const { documentId, tenantId: payloadTenantId } = job.data;

      if (job.name === "SEARCH_INDEX_DELETE") {
        logger.info({ documentId }, "removing document from search index");
        try {
          // Prefer tenantId from payload; fall back to a DB lookup (only
          // reachable for a legacy-shaped job with no payload.tenantId — that
          // fallback lookup runs with no tenant GUC, same documented
          // limitation as OCRWorker's own legacy fallback).
          let tenantId = payloadTenantId;
          if (!tenantId) {
            const doc = await Document.findByPk(documentId, { attributes: ["tenantId"] });
            tenantId = doc?.tenantId;
          }
          if (!tenantId || !meili) return;
          const indexName = `edms-docs-${tenantId}`;
          await meili.index(indexName).deleteDocument(documentId);
          logger.info({ documentId }, "document removed from search index");
        } catch (error) {
          logger.error({ error, documentId }, "search index delete failed");
          throw error;
        }
        return;
      }

      // Default: (re-)index the document
      logger.info({ documentId }, "indexing document for search");
      try {
        // Single joined query — eliminates the N+1 pattern of 4 separate fetches
        const document = await inTenantCtx(payloadTenantId, () =>
          Document.findByPk(documentId, {
            include: [
              { model: Department, as: "department" },
              { model: DocumentType, as: "documentType" },
              { model: DocumentMetadata, as: "metadata" },
              { model: DocumentVersion, as: "versions", limit: 1, order: [["createdAt", "DESC"]] }
            ]
          }),
        );
        if (!document) throw new Error("Document not found");
        if (!meili) return;

        const dept = (document as any).department;
        const docType = (document as any).documentType;
        const latestVersion = (document as any).versions?.[0];
        const metadata = (document as any).metadata;

        await ensureTenantIndexCached(document.tenantId);
        const indexName = `edms-docs-${document.tenantId}`;
        await meili.index(indexName).addDocuments([
          {
            id: document.id,
            tenantId: document.tenantId,
            documentName: document.documentName,
            title: document.title,
            // departmentId is the precise, collision-free filter field —
            // departmentCode stays only for backward compatibility with
            // saved searches serialized before it was added (see
            // search.service.ts's SearchFilters comment).
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
            archivedAt: document.archivedAt?.getTime()
          }
        ]);
        logger.info({ documentId }, "document indexed successfully");
      } catch (error) {
        logger.error({ error, documentId }, "search indexing failed");
        throw error;
      }
    },
    // No default concurrency here means BullMQ falls back to 1 — each job
    // indexes a single independent document (no ordering/lock requirement
    // like AuditChainWorker/LockWorker), so a burst of creates/updates was
    // serializing search-index freshness for no reason.
    { connection, concurrency: 5 }
  );
  attachErrorLogger(worker, "SEARCH_INDEX");
  // Unlike every other worker in this directory, this one had no `on("failed"
  // ...)` listener at all — a permanently-failed search-index job was only
  // ever visible in the local log line already inside the job function
  // above. Matches the convention every sibling worker follows.
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "search index job failed");
    reportJobFailure("SEARCH_INDEX", err, job?.id);
  });

  return worker;
}
