// SPRINT-5: legal-hold operations must remain the final block on destructive operations and audit changes.
import { Op } from "sequelize";
import {
  Document,
  DocumentLegalHold,
  LegalHold,
  OutboxEvent,
  User
} from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { runInTransaction } from "../../shared/transaction.js";
import { applyRetention } from "../retention/retentionEngine.js";

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
};

export async function createLegalHold(
  user: CurrentUser,
  input: {
    caseReference: string;
    description: string;
    custodianName: string;
    legalBasis: string;
    expectedDuration?: string;
    documentIds?: string[];
  }
) {
  if (!input.description || input.description.length < 20) {
    throw new AppError(400, "ERR-LEGAL-HOLD-VALIDATION", "Description must be at least 20 characters long");
  }
  if (!input.legalBasis || input.legalBasis.length < 20) {
    throw new AppError(400, "ERR-LEGAL-HOLD-VALIDATION", "Legal basis must be at least 20 characters long");
  }
  const caseRefRegex = /^[a-zA-Z0-9\-_/]{3,50}$/;
  if (!input.caseReference || !caseRefRegex.test(input.caseReference)) {
    throw new AppError(
      400,
      "ERR-LEGAL-HOLD-VALIDATION",
      "Case reference must be between 3 and 50 characters and contain only alphanumeric characters, hyphens, underscores, or slashes"
    );
  }

  const hold = await LegalHold.create({
    tenantId: user.tenantId,
    caseReference: input.caseReference,
    description: input.description,
    custodianName: input.custodianName,
    legalBasis: input.legalBasis,
    expectedDuration: input.expectedDuration ?? null,
    status: "ACTIVE",
    appliedById: user.userId
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LEGAL_HOLD_CREATE,
    userId: user.userId,
    userRole: user.role,
    actionDetails: { holdId: hold.id, caseReference: hold.caseReference }
  });

  if (Array.isArray(input.documentIds) && input.documentIds.length > 0) {
    await applyHoldToDocuments(hold.id, input.documentIds, user.userId, user.tenantId, user.role);
  }

  return hold;
}

// Platform audit finding (2026-08-14, CRITICAL): this had no tenantId filter
// at all — any user in ANY tenant holding LEGAL_HOLD_READ could list every
// other tenant's legal holds (case references, custodian names, affected
// document names). Legal holds are tenant-specific data, unlike retention
// policies (genuinely shared platform-wide config) — scope like every other
// tenant-owned table.
export function getLegalHolds(tenantId: string) {
  return LegalHold.findAll({
    where: { tenantId },
    include: [
      { model: User, as: "appliedBy", attributes: ["id", "firstName", "lastName", "email"] },
      {
        model: DocumentLegalHold,
        as: "affectedDocuments",
        attributes: ["id", "documentId", "addedAt", "removedAt"],
        include: [{ model: Document, as: "document", attributes: ["id", "documentName", "title", "status"] }]
      }
    ],
    order: [["createdAt", "DESC"]]
  });
}

export async function getLegalHold(id: string, tenantId: string) {
  const hold = await LegalHold.findOne({
    where: { id, tenantId },
    include: [
      { model: User, as: "appliedBy", attributes: ["id", "firstName", "lastName", "email"] },
      {
        model: DocumentLegalHold,
        as: "affectedDocuments",
        where: { removedAt: null },
        required: false,
        include: [{ model: Document, as: "document" }]
      }
    ]
  });
  // Same "treat cross-tenant as nonexistent" convention as
  // documentGuards.ts's requireDocumentAccess — a 404, not a 403, so a
  // different tenant's hold id can't even be confirmed to exist.
  if (!hold) throw new AppError(404, "ERR-HOLD-NOT-FOUND", "Legal hold not found");
  return hold;
}

// Platform audit finding (2026-08-14, CRITICAL): this had no tenantId check
// on either the hold or the documents being attached — a LEGAL_HOLD_MANAGE
// holder in tenant A could pass tenant B's document ids and successfully
// place tenant A's hold on them (and permanently block their mutation via
// legalHoldGuard). tenantId is now required and both sides are scoped by it;
// any documentId that doesn't belong to tenantId is silently excluded
// (treated as nonexistent), matching requireDocumentAccess's convention.
export async function applyHoldToDocuments(holdId: string, documentIds: string[], userId: string, tenantId: string, userRole?: string) {
  const hold = await LegalHold.findOne({ where: { id: holdId, tenantId } });
  if (!hold) throw new AppError(404, "ERR-HOLD-NOT-FOUND", "Legal hold not found");
  if (hold.status !== "ACTIVE") throw new AppError(409, "ERR-HOLD-INACTIVE", "Hold is not active");

  const documents = await Document.findAll({
    where: { id: documentIds, tenantId },
    attributes: ["id", "departmentId", "tenantId", "documentName"]
  });
  // Iterate the tenant-verified list below, not the raw documentIds — any id
  // that didn't come back from this query (wrong tenant, or just doesn't
  // exist) is silently dropped instead of still being written to
  // DocumentLegalHold/Document by id.
  const tenantScopedDocIds = documents.map((d) => d.id);
  const docMap = new Map(documents.map((d) => [d.id, d]));

  const existingHolds = await DocumentLegalHold.findAll({
    where: { documentId: tenantScopedDocIds, legalHoldId: holdId }
  });
  const existingHoldsMap = new Map(existingHolds.map((h) => [h.documentId, h]));

  for (const docId of tenantScopedDocIds) {
    const existing = existingHoldsMap.get(docId);
    if (!existing || existing.removedAt) {
      const doc = docMap.get(docId);
      await runInTransaction(async (transaction) => {
        if (existing) await existing.update({ removedAt: null }, { transaction });
        else await DocumentLegalHold.create({ documentId: docId, legalHoldId: holdId }, { transaction });
        await Document.update({ isOnLegalHold: true }, { where: { id: docId }, transaction });
        await OutboxEvent.create(
          {
            documentId: docId,
            type: "DOCUMENT.HOLD_APPLIED",
            channel: "WEBSOCKET",
            // payload.tenantId lets the webhook fan-out scope its subscriber
            // lookup without the RLS-latent documents fallback read.
            payload: JSON.stringify({ documentId: docId, holdId, departmentId: doc?.departmentId, tenantId: doc?.tenantId })
          },
          { transaction }
        );
        // Owner email (suppressible via the emailOnLegalHold preference) —
        // the enforcement itself never depends on this notice being read.
        await OutboxEvent.create(
          {
            documentId: docId,
            type: "LEGALHOLD.DOCUMENT_HELD",
            channel: "EMAIL",
            payload: JSON.stringify({
              documentId: docId,
              documentName: doc?.documentName,
              caseReference: hold.caseReference,
              custodianName: hold.custodianName,
              tenantId: doc?.tenantId,
            })
          },
          { transaction }
        );
      });
      await writeAuditLog({
        eventType: AUDIT_EVENTS.LEGAL_HOLD_APPLY,
        userId,
        userRole,
        documentId: docId,
        actionDetails: { holdId, caseReference: hold.caseReference }
      });
    }
  }
  return { success: true };
}

export async function releaseLegalHold(
  holdId: string,
  userId: string,
  userRole: string | undefined,
  closureRef: string,
  reason: string,
  tenantId: string,
) {
  const hold = await LegalHold.findOne({ where: { id: holdId, tenantId } });
  if (!hold) throw new AppError(404, "ERR-HOLD-NOT-FOUND", "Legal hold not found");
  if (hold.status !== "ACTIVE") throw new AppError(409, "ERR-HOLD-INACTIVE", "Hold is not active");

  await runInTransaction(async (transaction) => {
    await hold.update(
      {
        status: "RELEASED",
        releasedAt: new Date(),
        releasedById: userId,
        releaseClosureRef: closureRef,
        releaseReason: reason
      },
      { transaction }
    );

    const affected = await DocumentLegalHold.findAll({ where: { legalHoldId: holdId, removedAt: null }, transaction });
    for (const rel of affected) {
      await rel.update({ removedAt: new Date() }, { transaction });
      const otherHolds = await DocumentLegalHold.count({
        where: { documentId: rel.documentId, legalHoldId: { [Op.ne]: holdId }, removedAt: null },
        transaction
      });
      if (otherHolds === 0) {
        const doc = await Document.findByPk(rel.documentId, { attributes: ["id", "departmentId", "tenantId", "documentName"], transaction });
        await Document.update({ isOnLegalHold: false }, { where: { id: rel.documentId }, transaction });
        await recomputeDisposalDate(rel.documentId, transaction);

        // AUDIT-FINDINGS-2026-08-11 data-flow sweep #4: applyHoldToDocuments
        // fans out both a WEBSOCKET (webhook-eligible) event and an owner
        // email; release had neither — an integration that blocked/flagged
        // the document on DOCUMENT.HOLD_APPLIED had no signal to unblock it,
        // and the owner was never told the freeze on their document lifted.
        await OutboxEvent.create(
          {
            documentId: rel.documentId,
            type: "DOCUMENT.HOLD_RELEASED",
            channel: "WEBSOCKET",
            payload: JSON.stringify({ documentId: rel.documentId, holdId, departmentId: doc?.departmentId, tenantId: doc?.tenantId }),
          },
          { transaction },
        );
        await OutboxEvent.create(
          {
            documentId: rel.documentId,
            type: "LEGALHOLD.DOCUMENT_RELEASED",
            channel: "EMAIL",
            payload: JSON.stringify({
              documentId: rel.documentId,
              documentName: doc?.documentName,
              caseReference: hold.caseReference,
              closureRef,
              tenantId: doc?.tenantId,
            }),
          },
          { transaction },
        );
      }
    }
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LEGAL_HOLD_RELEASE,
    userId,
    userRole,
    actionDetails: { holdId, caseReference: hold.caseReference, closureRef, reason }
  });
  return { success: true };
}

// One canonical computation lives in the retention engine — this wrapper is
// kept for its existing call sites and re-syncs the warning rows too.
export async function recomputeDisposalDate(documentId: string, transaction?: import("sequelize").Transaction) {
  await applyRetention(documentId, transaction);
}
