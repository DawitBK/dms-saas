// S4-09: Async ClamAV scan via BullMQ (files > 100 MB)
import { Worker, Job } from "bullmq";
import { logger } from "../../../core/logger.js";
import { getRedis } from "../../cache/redis.js";
import { scanBuffer } from "../../antivirus/clamscan.js";
import { getStorageAdapter } from "../../storage/StorageAdapter.js";
import { Document, DocumentVersion } from "../../database/index.js";
import { writeAuditLog } from "../../../modules/audit/audit.service.js";
import { AUDIT_EVENTS } from "../../../modules/audit/auditEvents.js";
import { fanOut } from "../../../modules/notifications/notifications.service.js";
import { fetchAndDecrypt } from "../../../modules/documents/documentCrypto.js";
import { AppError } from "../../../core/AppError.js";
import { withWorkerTenantContext } from "../../../shared/workerTenantContext.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

export type ScanJobPayload = {
  documentId: string;
  versionId: string;
  storageKey: string;
  tenantId: string;
  userId: string;
  userRole: string;
};

const QUARANTINE_PREFIX = "quarantine/";

async function processScanJob(job: Job<ScanJobPayload>): Promise<void> {
  const { documentId, versionId, storageKey, tenantId, userId, userRole } = job.data;

  logger.info({ documentId, storageKey }, "Starting async virus scan");

  try {
    // Fetch and decrypt the file first, because ClamAV cannot scan encrypted ciphertext
    const plaintextBuffer = await fetchAndDecrypt(storageKey, versionId);

    // Scan the decrypted plaintext buffer. Only a genuine detected virus
    // throws AppError (caught below and quarantined); a scan that merely
    // failed to complete (timeout, daemon crash, protocol error) returns
    // "unscanned" instead — that must NOT be treated the same as a real
    // threat. It previously was: any error here, infection or infra
    // failure alike, fell into the same catch block below, which deleted
    // the file and fired a CRITICAL VIRUS_DETECTED alert even when nothing
    // was actually found — a ClamAV hiccup on a large legitimate upload
    // destroyed it and paged security for nothing.
    const scanResult = await scanBuffer(plaintextBuffer);

    // withWorkerTenantContext: this worker has no ambient tenant context of
    // its own (unlike an HTTP request's tenantContext middleware), and
    // `documents` has row-level security with NO fail-open arm for a missing
    // GUC (unlike document_versions, which has no RLS at all) — a bare write
    // here would silently affect 0 rows the day the DB role is switched to
    // the restricted edams_app role, permanently stranding this document in
    // SCAN_PENDING with an audit trail that claims the scan succeeded. Same
    // pattern already used by WorkflowWorker.ts/RetentionPurgeWorker.ts.
    await withWorkerTenantContext(tenantId, async () => {
      await DocumentVersion.update({ avScanStatus: scanResult }, { where: { id: versionId } });

      // Promote only if the document is still awaiting scan clearance (don't
      // clobber a doc that moved on to review/archive since). Large NEW
      // uploads are created in SCAN_PENDING and, once cleared (scanned clean
      // OR fail-open unscanned — same policy as the inline scan path), land
      // in DRAFT — the same birth state a small (inline-scanned) upload gets.
      //
      // This used to ALSO flip any DRAFT or QUARANTINED document to ACTIVE
      // (a leftover from before the approval engine, when DRAFT meant "not yet
      // scanned"). A >100 MB new version of a DRAFT document therefore published
      // the document the moment its scan finished — skipping the approval chain
      // its type requires — and a clean scan of one version silently released a
      // document quarantined for a virus in another. Leaving quarantine is a
      // deliberate act (QUARANTINED->ACTIVE needs document:archive).
      await Document.update(
        { status: "DRAFT" },
        { where: { id: documentId, status: "SCAN_PENDING" } }
      );

      await writeAuditLog({
        eventType: scanResult === "clean" ? AUDIT_EVENTS.DOCUMENT_SCAN_CLEAN : AUDIT_EVENTS.DOCUMENT_SCAN_UNSCANNED,
        userId,
        userRole,
        documentId,
        actionDetails: scanResult === "clean"
          ? { scanResult: "clean", storageKey }
          : { versionId, reason: "clamav scan did not complete; upload allowed through (fail-open)", storageKey },
      });

      // Large uploads finish after the HTTP response, so the uploader cannot
      // learn their final outcome from the original request. Create a durable,
      // real-time notification in the same tenant transaction (rather than a
      // direct worker-process socket emit, which is a no-op) for both the
      // clean and fail-open-unscanned outcomes.
      await fanOut({
        type: "DOCUMENT_SCAN_COMPLETED",
        tenantId,
        recipientIds: [userId],
        severity: scanResult === "clean" ? "INFO" : "WARNING",
        payload: { documentId, versionId, scanStatus: scanResult },
      });
    });

    logger.info({ documentId, scanResult }, "Async virus scan completed");
  } catch (error: any) {
    if (!(error instanceof AppError && error.code === "ERR-AV-THREAT-DETECTED")) {
      // Not a detected virus — an unexpected failure elsewhere in this job
      // (decrypt, DB update, etc). Re-throw so BullMQ retries the job rather
      // than quarantining a file over an unrelated infrastructure error.
      logger.error({ error, documentId, storageKey }, "Async virus scan job failed (not a detected threat)");
      throw error;
    }

    // Virus genuinely detected
    logger.error({ error, documentId, storageKey }, "Virus detected");

    try {
      const storage = getStorageAdapter();
      
      // Move to quarantine
      const quarantineKey = QUARANTINE_PREFIX + storageKey;
      const encryptedBuffer = await storage.get(storageKey + ".enc");
      await storage.put(quarantineKey + ".enc", encryptedBuffer, "application/octet-stream");
      
      // Delete original
      await storage.delete(storageKey + ".enc");

      // Update document status + audit — same tenant-context requirement as
      // the clean/unscanned path above (documents' RLS has no fail-open arm
      // for a missing GUC).
      await withWorkerTenantContext(tenantId, async () => {
        await Document.update(
          { status: "QUARANTINED" },
          { where: { id: documentId } }
        );

        // Emit VIRUS_DETECTED audit event
        await writeAuditLog({
          eventType: AUDIT_EVENTS.VIRUS_DETECTED,
          userId,
          userRole,
          documentId,
          actionDetails: {
            storageKey,
            quarantineKey,
            scanError: error.message
          }
        });
      });

    await fanOut({
      type: "VIRUS_DETECTED",
      tenantId: tenantId,
      severity: "CRITICAL",
      payload: { documentId, storageKey, scanError: error.message },
    });
      
      // Note: sendNotification would be implemented here when websocket notifications are wired
      // For now, the audit log and status change provide notification capability
      
      logger.warn({ documentId, quarantineKey }, "Document quarantined due to virus detection");
    } catch (quarantineError: any) {
      logger.error({ error: quarantineError, documentId }, "Failed to quarantine document");
      throw quarantineError;
    }
  }
}

export function createScanWorker(): Worker {
  const connection = getRedis();
  if (!connection) {
    logger.warn("redis not configured; scan worker not started");
    return null as any;
  }

  const worker = new Worker<ScanJobPayload>(
    "VIRUS_SCAN", // Must match the queue name in queues.ts
    async (job) => {
      await processScanJob(job);
    },
    {
      connection,
      concurrency: 2, // Process 2 scans concurrently
      limiter: {
        max: 10, // Max 10 scans
        duration: 60000 // Per minute
      }
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "Scan job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, documentId: job?.data.documentId, error },
      "Scan job failed"
    );
    reportJobFailure("VIRUS_SCAN", error, job?.id);
  });

  // Missed in the earlier BullMQ-crash hardening pass — without this, a
  // transient Redis error on this Worker's connection throws unhandled and
  // (via bin/worker.ts's uncaughtException net) shuts down the whole worker
  // process, taking every other queue (OCR, email, retention, SLA...) down
  // with it over what should be an isolated virus-scan hiccup.
  attachErrorLogger(worker, "VIRUS_SCAN");

  return worker;
}
