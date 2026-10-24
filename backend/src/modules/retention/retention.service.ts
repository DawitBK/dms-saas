import { z } from "zod";
import { Op, QueryTypes } from "sequelize";
import { ArchiveRecord, Document, DocumentVersion, OutboxEvent, RetentionPolicy, sequelize } from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { runInTransaction } from "../../shared/transaction.js";
import { reapplyRetentionForPolicyCode } from "./retentionEngine.js";
import { withWorkerTenantContext } from "../../shared/workerTenantContext.js";

// code max matches the retention_policies.code column (VARCHAR(50)); seeded
// codes like RET-OPS-PERM-ACTIVE exceed the old max(10).
const retentionPolicySchema = z.object({
  code: z.string().min(2).max(50),
  name: z.string().min(1).max(255),
  retentionYears: z.number().int().min(0).nullable().optional(),
  isPermanent: z.boolean().optional(),
  triggerEvent: z.string().min(1).max(100),
  disposalAction: z.string().min(1).max(100),
  authority: z.string().min(1).max(255),
  isActive: z.boolean().optional()
});

export async function listRetentionPolicies() {
  return RetentionPolicy.findAll({ 
    where: { isActive: true },
    order: [["code", "ASC"]] 
  });
}

export async function getRetentionPolicy(id: string) {
  const policy = await RetentionPolicy.findByPk(id);
  if (!policy) throw new AppError(404, 'ERR-RETENTION-NOT-FOUND', 'Retention policy not found');
  return policy;
}

export async function createRetentionPolicy(input: unknown, requesterId: string) {
  const data = retentionPolicySchema.parse(input);
  const policy = await RetentionPolicy.create({
    ...data,
    code: data.code.toUpperCase(),
    isActive: data.isActive ?? true
  });
  
  await writeAuditLog({ 
    eventType: AUDIT_EVENTS.RETENTION_CREATED, 
    userId: requesterId,
    actionDetails: { policyId: policy.id, code: policy.code } 
  });
  
  return policy;
}

export async function updateRetentionPolicy(id: string, input: unknown, requesterId: string) {
  const data = retentionPolicySchema.partial().parse(input);
  const policy = await RetentionPolicy.findByPk(id);
  if (!policy) throw new AppError(404, 'ERR-RETENTION-NOT-FOUND', 'Retention policy not found');
  
  await policy.update({ ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.RETENTION_UPDATED,
    userId: requesterId,
    actionDetails: { policyId: id, updates: data }
  });

  // Retention engine (gap #1): years/trigger changes move every affected
  // document's disposal clock — recompute them now.
  if (data.retentionYears !== undefined || data.triggerEvent !== undefined || data.isPermanent !== undefined) {
    await reapplyRetentionForPolicyCode(policy.code);
  }

  return policy;
}

export async function deactivateRetentionPolicy(id: string, requesterId: string) {
  const policy = await RetentionPolicy.findByPk(id);
  if (!policy) throw new AppError(404, 'ERR-RETENTION-NOT-FOUND', 'Retention policy not found');

  const activeDocCount = await Document.count({
    where: { 
      retentionClass: policy.code, 
      deletedAt: null,
      status: { [Op.notIn]: ['CANCELLED', 'DISPOSED', 'ARCHIVED'] } 
    }
  });
  if (activeDocCount > 0)
    throw new AppError(409, 'ERR-RETENTION-IN-USE',
      `Cannot deactivate: ${activeDocCount} document(s) use this retention class`);

  await policy.update({ isActive: false });
  
  await writeAuditLog({ 
    eventType: AUDIT_EVENTS.RETENTION_DEACTIVATED, 
    userId: requesterId,
    actionDetails: { policyId: id, code: policy.code } 
  });
  
  return policy;
}

export async function processRetentionQueue() {
  logger.info("processing retention queue");
  // Gap #1 fix: key the sweep off the computed disposalEligibleDate, not
  // retentionTriggerDate — the trigger date is an optional upload field, and
  // requiring it silently excluded almost every document from disposition.
  //
  // FIX 2026-09-23: PLATFORM-VERIFICATION-AUDIT-2026-09-19 §7.3 correctly
  // scoped each document's WRITE to withWorkerTenantContext, reasoning (see
  // its comment, now below) that the initial findAll had to stay a single
  // cross-tenant query since the sweep must cover every tenant. That reasoning
  // held for outbox_events/documents' own write path, but missed that the
  // READ itself needed the exact same scoping: `documents` FORCE-enables RLS
  // with a strict tenant_id-match policy and no fail-open clause, so this
  // findAll, run with no app.current_tenant ever set, returned ZERO rows
  // under the app's real (non-superuser) production DB role — the same
  // silent-empty-result class of bug already found and fixed this session in
  // the folder-org-unit backfill script and the public letters-verify route.
  // Concretely: this sweep has never found a single document to disposal-flag
  // in production, regardless of how many were actually eligible — retention
  // disposal has been silently dead since RLS enforcement went strict.
  // Loop the tenant registry (tenant-agnostic, no RLS) and scope the SELECT
  // itself per tenant, same as every other cross-tenant sweep in this file's
  // sibling services now does.
  const tenants = await sequelize.query<{ id: string }>("SELECT id FROM tenants", { type: QueryTypes.SELECT });
  const now = new Date();

  for (const { id: tenantId } of tenants) {
    await withWorkerTenantContext(tenantId, async () => {
      const archivedDocs = await Document.findAll({
        where: { status: "ARCHIVED", isOnLegalHold: false, disposalEligibleDate: { [Op.ne]: null } },
        include: [{ model: DocumentVersion, as: "versions", limit: 1, separate: true, order: [["createdAt", "DESC"]] }]
      });

      for (const doc of archivedDocs) {
        if (doc.disposalEligibleDate && now > doc.disposalEligibleDate) {
          logger.info({ documentId: doc.id }, "document eligible for disposal");
          await doc.update({ status: "DISPOSAL_PENDING" });
          await OutboxEvent.create({
            type: "RETENTION.DISPOSAL_PENDING",
            channel: "EMAIL",
            // Set the top-level documentId column AND payload.tenantId so the webhook
            // fan-out can resolve a tenant. Previously documentId lived only inside
            // the payload JSON, so both resolution paths were empty and external
            // subscribers never received DISPOSAL_PENDING (S19 audit finding).
            documentId: doc.id,
            payload: JSON.stringify({ documentId: doc.id, documentName: doc.documentName, tenantId: doc.tenantId })
          });
        }
      }
    });
  }
}

export async function authoriseDisposal(documentId: string, userId: string, tenantId?: string) {
  const document = await Document.findByPk(documentId, { include: [{ model: DocumentVersion, as: "versions" }] });
  // Tenant isolation before any state disclosure: a foreign-tenant document is a 404.
  if (!document || (tenantId && document.tenantId && document.tenantId !== tenantId)) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }
  if (document.status !== "DISPOSAL_PENDING") {
    throw new AppError(409, "ERR-RETENTION-INVALID-STATE", "Document not pending disposal");
  }

  if (document.isOnLegalHold) {
    throw new AppError(409, "ERR-RETENTION-HOLD-ACTIVE", "Cannot authorise disposal: Document is on active legal hold");
  }

  return runInTransaction(async (transaction) => {
    await document.update({ status: "DISPOSED" }, { transaction });
    for (const version of (document as any).versions ?? []) {
      await version.update({ storageKey: "DELETED" }, { transaction });
    }
    const [archive] = await ArchiveRecord.findOrCreate({
      where: { documentId },
      defaults: { documentId, status: "DISPOSED", disposedAt: new Date(), archiveStorageTier: "WARM" },
      transaction
    });
    await archive.update({ status: "DISPOSED", disposedAt: new Date() }, { transaction });
    // audit 2026-08-11 data-flow sweep #5: staging (processRetentionQueue)
    // fans out RETENTION.DISPOSAL_PENDING (WEBSOCKET, webhook-eligible, + owner
    // EMAIL); the irreversible execution step that actually follows it had
    // neither — external/compliance systems were told a document might be
    // disposed of soon but never told it actually was.
    await OutboxEvent.create(
      {
        documentId,
        type: "RETENTION.DISPOSAL_EXECUTED",
        channel: "WEBSOCKET",
        payload: JSON.stringify({ documentId, departmentId: document.departmentId, tenantId: document.tenantId }),
      },
      { transaction },
    );
    await OutboxEvent.create(
      {
        documentId,
        type: "RETENTION.DISPOSAL_EXECUTED",
        channel: "EMAIL",
        payload: JSON.stringify({ documentId, documentName: document.documentName, tenantId: document.tenantId }),
      },
      { transaction },
    );
    await writeAuditLog({
      eventType: AUDIT_EVENTS.DISPOSAL_EXECUTE,
      userId,
      documentId,
      actionDetails: { documentName: document.documentName }
    });
    return { success: true };
  });
}

export async function restoreFromCold(documentId: string, userId: string, tenantId?: string) {
  // Tenant isolation: verify the underlying document belongs to the caller's tenant.
  const document = await Document.findByPk(documentId, { attributes: ["id", "tenantId"] });
  if (!document || (tenantId && document.tenantId && document.tenantId !== tenantId)) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  const archive = await ArchiveRecord.findOne({ where: { documentId } });
  if (!archive) {
    throw new AppError(404, "ERR-ARCHIVE-NOT-FOUND", "Archive record not found for document");
  }

  if (archive.archiveStorageTier !== "COLD") {
    throw new AppError(400, "ERR-ARCHIVE-NOT-COLD", "Document is not in cold storage");
  }

  await archive.update({ archiveStorageTier: "WARM" });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.RETENTION_COLD_RESTORE,
    userId,
    documentId,
    actionDetails: { message: "Restored from COLD to WARM storage tier" }
  });

  return { success: true, archiveStorageTier: "WARM" };
}

