// Audit stage decisions (SYSTEM-DECISIONS.md D5–D7).
//
// After final approval, a type with auditPolicy required/optional routes the
// item to a named auditor picked by the FINAL APPROVER (D6). The auditor
// PASSes (→ AUDITED, archivable) or FLAGs with mandatory findings — a FLAG
// returns the item to the final approver, who owns remediation (D7) and
// re-submits it to audit (picking an auditor again) once fixed.

import { Op } from "sequelize";
import { z } from "zod";
import {
  AuditStageReview,
  Document,
  User,
  UserDepartment,
} from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { fanOut } from "../notifications/notifications.service.js";
import { enqueueWebsocketEvent } from "../../infrastructure/queue/outbox.js";
import { logger } from "../../core/logger.js";
import { runInTransaction } from "../../shared/transaction.js";
import { assertNotHiddenUser } from "../../shared/platformAdmin.js";
import { validateTransition } from "../documents/DocumentStateMachine.js";
import { applyRetention } from "../retention/retentionEngine.js";
import { requireLegalHoldClear, type GuardDocument } from "../../shared/documentGuards.js";
import { MY_WORK_QUEUE_CAP, grantChainParticipantAcl, type CurrentUser } from "./approvals.service.js";

/** Same realtime gap as approvals.service.ts's emitApprovalChainUpdated
 *  (audit 2026-07-26 #8) — the audit stage is a distinct decision
 *  point (PASS/FLAG) reachable after approval completes, and had no realtime
 *  wiring of its own either. */
async function emitApprovalChainUpdated(
  itemType: string,
  itemId: string,
  tenantId: string,
  departmentId: string | null | undefined,
  change: string,
) {
  try {
    await enqueueWebsocketEvent("APPROVAL_CHAIN.UPDATED", {
      documentId: itemType === "DOCUMENT" ? itemId : undefined,
      itemType,
      itemId,
      change,
      departmentId: departmentId ?? null,
      tenantId,
    });
  } catch (e) {
    logger.error({ e }, "websocket enqueue failed");
  }
}

const auditDecisionSchema = z.object({
  decision: z.enum(["PASS", "FLAG"]),
  findings: z.string().max(8000).optional(),
});

function hasPermission(user: CurrentUser, permission: string): boolean {
  return (user.permissions ?? []).includes(permission);
}

export async function decideAuditReview(reviewId: string, input: unknown, user: CurrentUser) {
  const { decision, findings } = auditDecisionSchema.parse(input);
  if (!hasPermission(user, PERMISSIONS.AUDIT_STAGE_DECIDE))
    throw new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${PERMISSIONS.AUDIT_STAGE_DECIDE}`);

  const review = await AuditStageReview.findOne({ where: { id: reviewId, tenantId: user.tenantId } });
  if (!review) throw new AppError(404, "ERR-AUDIT-REVIEW-NOT-FOUND", "Audit review not found");
  if (review.status !== "PENDING")
    throw new AppError(409, "ERR-AUDIT-REVIEW-DECIDED", "This audit review has already been decided");
  if (review.auditorUserId !== user.userId)
    throw new AppError(403, "ERR-AUDIT-NOT-ASSIGNED", "This audit review is not assigned to you");

  // M4: a trashed/deleted document must not be decidable — otherwise the
  // auditor could flip a trashed doc PENDING_AUDIT → AUDITED/AUDIT_FLAGGED.
  const guardDoc = await Document.findByPk(review.itemId, { attributes: ["id", "deletedAt", "status", "departmentId", "isOnLegalHold"] });
  if (!guardDoc || guardDoc.deletedAt || guardDoc.status === "TRASHED")
    throw new AppError(409, "ERR-DOCUMENT-TRASHED", "The item is no longer available for audit");
  // audit 2026-08-11 lifecycle sweep #2: same as approvals.service.ts's
  // decideStep — a PASS here is a document's terminal clearance stage (goes
  // ACTIVE immediately), which must not be reachable while the item is frozen
  // for litigation/records purposes.
  requireLegalHoldClear(guardDoc as unknown as GuardDocument);

  // D7: FLAG requires written findings.
  if (decision === "FLAG" && !findings?.trim())
    throw new AppError(422, "ERR-FINDINGS-REQUIRED", "Flagging requires written findings");

  await runInTransaction(async (tx) => {
    // Status-guarded: two simultaneous decisions → exactly one winner.
    const [updated] = await AuditStageReview.update(
      {
        status: decision === "PASS" ? "PASSED" : "FLAGGED",
        findings: findings ?? null,
        decidedAt: new Date(),
      },
      { where: { id: reviewId, status: "PENDING" }, transaction: tx },
    );
    if (updated !== 1)
      throw new AppError(409, "ERR-AUDIT-REVIEW-DECIDED", "This audit review has already been decided");

    const doc = await Document.findByPk(review.itemId, { transaction: tx });
    if (doc && doc.status === "PENDING_AUDIT") {
      const to = decision === "PASS" ? "AUDITED" : "AUDIT_FLAGGED";
      validateTransition(doc.status, to);
      await doc.update({ status: to }, { transaction: tx });

      // By the time a document reaches PENDING_AUDIT, any required signing
      // ceremony has already completed (D8: ceremony types sign before
      // audit) — a PASS here is always this document's terminal clearance
      // stage, so it goes straight to ARCHIVED instead of parking at AUDITED
      // waiting for a separate manual archive step (see the equivalent
      // default in approvals.service.ts's completeItemApproval and
      // esigning.service.ts's ceremony-completion path). The Activate action
      // (ARCHIVED -> ACTIVE) brings it back live if it's needed again.
      if (decision === "PASS") {
        validateTransition("AUDITED", "ARCHIVED");
        const now = new Date();
        await doc.update({ status: "ARCHIVED", archivedAt: now }, { transaction: tx });
        await applyRetention(doc.id, tx);
      }
    }
  });

  await writeAuditLog({
    eventType: decision === "PASS" ? AUDIT_EVENTS.AUDIT_STAGE_PASSED : AUDIT_EVENTS.AUDIT_STAGE_FLAGGED,
    userId: user.userId,
    userRole: user.role,
    documentId: review.itemType === "DOCUMENT" ? review.itemId : undefined,
    actionDetails: { reviewId, findings: findings ?? null },
  });
  // D7: the FINAL APPROVER (who assigned the audit) owns the outcome.
  await fanOut({
    type: decision === "PASS" ? "AUDIT_STAGE_PASSED" : "AUDIT_STAGE_FLAGGED",
    tenantId: user.tenantId,
    recipientIds: [review.assignedBy],
    severity: decision === "PASS" ? "INFO" : "WARNING",
    payload: { reviewId, itemType: review.itemType, itemId: review.itemId, findings: findings ?? null },
  }).catch(() => {});
  await emitApprovalChainUpdated(review.itemType, review.itemId, user.tenantId, guardDoc.departmentId, decision === "PASS" ? "audit_passed" : "audit_flagged");

  return AuditStageReview.findByPk(reviewId);
}

/** After remediation, the final approver re-submits a FLAGGED item to audit
 *  (D7) — a fresh PENDING review, auditor picked again by the approver. The
 *  independence rules from the original assignment are enforced by the
 *  approvals service when documents complete approval; here the re-submitter
 *  must be the approver who owned the flag. */
export async function resubmitToAudit(itemId: string, auditorUserId: string, user: CurrentUser) {
  const flagged = await AuditStageReview.findOne({
    where: { itemId, tenantId: user.tenantId, status: "FLAGGED" },
    order: [["createdAt", "DESC"]],
  });
  if (!flagged) throw new AppError(404, "ERR-AUDIT-REVIEW-NOT-FOUND", "No flagged audit review for this item");
  const isFlagOwner = flagged.assignedBy === user.userId;
  if (!isFlagOwner && !hasPermission(user, PERMISSIONS.APPROVAL_ADMIN))
    throw new AppError(403, "ERR-NOT-FLAG-OWNER", "Only the approver who assigned the audit (or an approval admin) can re-submit it");
  // Platform audit finding (2026-08-14, HIGH, follow-up): the flag-owner
  // branch above is already correctly scoped (you were the approver who
  // processed this document), but the APPROVAL_ADMIN override had no
  // department check at all — APPROVAL_ADMIN is a plain per-tenant
  // permission held by DEPT_MANAGER, an ordinary per-department role, so a
  // Finance DEPT_MANAGER could re-route an HR document's audit to an
  // arbitrary auditor purely by knowing/guessing its itemId.
  if (!isFlagOwner && !hasPermission(user, PERMISSIONS.DOCUMENT_READ_ALL)) {
    const doc = await Document.findOne({ where: { id: itemId, tenantId: user.tenantId }, attributes: ["departmentId"] });
    if (doc?.departmentId) {
      const memberships = await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ["departmentId"] });
      if (!memberships.some((m) => m.departmentId === doc.departmentId))
        throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "This item belongs to a department you are not a member of");
    }
  }
  // The hidden platform administrator can never be picked as an auditor (answers like an unknown user).
  await assertNotHiddenUser(auditorUserId, user.userId);
  if (auditorUserId === user.userId)
    throw new AppError(422, "ERR-AUDITOR-CONFLICT", "The auditor cannot be an approver of this item");

  const review = await runInTransaction(async (tx) => {
    const doc = await Document.findByPk(itemId, { transaction: tx });
    if (!doc || doc.tenantId !== user.tenantId)
      throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
    if (doc.status !== "AUDIT_FLAGGED")
      throw new AppError(409, "ERR-AUDIT-STATE-INVALID", `Document is ${doc.status}, not AUDIT_FLAGGED`);
    validateTransition(doc.status, "PENDING_AUDIT");
    await doc.update({ status: "PENDING_AUDIT" }, { transaction: tx });
    const created = await AuditStageReview.create(
      {
        tenantId: user.tenantId,
        itemType: "DOCUMENT",
        itemId,
        auditorUserId,
        assignedBy: user.userId,
        status: "PENDING",
      },
      { transaction: tx },
    );
    // The (possibly cross-department) auditor must be able to open what they audit, attachments included.
    await grantChainParticipantAcl(itemId, user.tenantId, user.userId, [{ assignedUserId: auditorUserId }], tx);
    return created;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUDIT_STAGE_ASSIGNED,
    userId: user.userId,
    userRole: user.role,
    documentId: itemId,
    actionDetails: { reviewId: review.id, auditorUserId, resubmission: true },
  });
  await fanOut({
    type: "AUDIT_STAGE_ASSIGNED",
    tenantId: user.tenantId,
    recipientIds: [auditorUserId],
    severity: "INFO",
    payload: { reviewId: review.id, itemType: "DOCUMENT", itemId },
  }).catch(() => {});
  return review;
}

/**
 * M3: PENDING_AUDIT was a dead-end if the picked auditor was deactivated or left
 * — decideAuditReview hard-requires the exact assigned auditor and there was no
 * reassignment path. This lets the original assigner or an approval admin point
 * a still-PENDING review at a different auditor, keeping the document moving.
 */
export async function reassignAuditor(reviewId: string, newAuditorUserId: string, user: CurrentUser) {
  const review = await AuditStageReview.findOne({ where: { id: reviewId, tenantId: user.tenantId } });
  if (!review) throw new AppError(404, "ERR-AUDIT-REVIEW-NOT-FOUND", "Audit review not found");
  if (review.status !== "PENDING")
    throw new AppError(409, "ERR-AUDIT-REVIEW-DECIDED", "Only a pending audit review can be reassigned");
  const isAssigner = review.assignedBy === user.userId;
  if (!isAssigner && !hasPermission(user, PERMISSIONS.APPROVAL_ADMIN))
    throw new AppError(403, "ERR-NOT-FLAG-OWNER", "Only the assigner or an approval admin can reassign this audit");
  // Platform audit finding (2026-08-14, HIGH, follow-up): same gap as
  // resubmitToAudit above — the assigner branch is already correctly scoped,
  // but the APPROVAL_ADMIN override had no department check, letting a
  // Finance DEPT_MANAGER redirect an HR document's pending audit to an
  // arbitrary auditor purely by knowing/guessing the reviewId.
  if (!isAssigner && !hasPermission(user, PERMISSIONS.DOCUMENT_READ_ALL) && review.itemType === "DOCUMENT") {
    const doc = await Document.findOne({ where: { id: review.itemId, tenantId: user.tenantId }, attributes: ["departmentId"] });
    if (doc?.departmentId) {
      const memberships = await UserDepartment.findAll({ where: { userId: user.userId }, attributes: ["departmentId"] });
      if (!memberships.some((m) => m.departmentId === doc.departmentId))
        throw new AppError(403, "ERR-STEP-DEPT-SCOPE", "This item belongs to a department you are not a member of");
    }
  }
  if (!newAuditorUserId) throw new AppError(422, "ERR-AUDITOR-REQUIRED", "auditorUserId is required");
  await assertNotHiddenUser(newAuditorUserId, user.userId);
  if (newAuditorUserId === review.assignedBy)
    throw new AppError(422, "ERR-AUDITOR-CONFLICT", "The auditor cannot be the approver who assigned the audit");

  const newAuditor = await User.findOne({ where: { id: newAuditorUserId, isActive: true } });
  if (!newAuditor) throw new AppError(404, "ERR-USER-NOT-FOUND", "New auditor not found or inactive");

  // FIX (platform audit finding 4.10): the PENDING check above ran unlocked,
  // so a concurrent decideAuditReview could decide this same review between
  // that check and this write, stamping a new auditor onto an
  // already-PASSED/FLAGGED row. Same status-guarded atomic update pattern as
  // decideAuditReview's own write: only succeeds while still PENDING.
  await runInTransaction(async (tx) => {
    const [updated] = await AuditStageReview.update(
      { auditorUserId: newAuditorUserId },
      { where: { id: reviewId, status: "PENDING" }, transaction: tx },
    );
    if (updated !== 1)
      throw new AppError(409, "ERR-AUDIT-REVIEW-DECIDED", "This audit review has already been decided");
    await grantChainParticipantAcl(
      review.itemType === "DOCUMENT" ? review.itemId : null,
      user.tenantId,
      user.userId,
      [{ assignedUserId: newAuditorUserId }],
      tx,
    );
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.AUDIT_STAGE_ASSIGNED,
    userId: user.userId,
    userRole: user.role,
    documentId: review.itemType === "DOCUMENT" ? review.itemId : undefined,
    actionDetails: { reviewId, auditorUserId: newAuditorUserId, reassigned: true },
  });
  await fanOut({
    type: "AUDIT_STAGE_ASSIGNED",
    tenantId: user.tenantId,
    recipientIds: [newAuditorUserId],
    severity: "INFO",
    payload: { reviewId, itemType: review.itemType, itemId: review.itemId },
  }).catch(() => {});

  return AuditStageReview.findByPk(reviewId);
}

/** The Audits queue of the My Work inbox. */
export async function listMyPendingAudits(user: CurrentUser) {
  const reviews = await AuditStageReview.findAll({
    where: { tenantId: user.tenantId, auditorUserId: user.userId, status: "PENDING" },
    include: [{ model: User, as: "assigner", attributes: ["id", "firstName", "lastName", "email"] }],
    // Newest-first, matching the other My Work queues.
    order: [["createdAt", "DESC"]],
    // Bounded like every other My Work queue — see MY_WORK_QUEUE_CAP.
    limit: MY_WORK_QUEUE_CAP,
  });

  // Batch-load the backing documents. This was one Document.findByPk per
  // review, awaited sequentially inside the loop below — the exact N+1
  // listMyPendingSteps already carries a comment about having fixed on its
  // own side, so an auditor with 40 pending reviews paid 40 serial round
  // trips on every My Work poll instead of one query.
  const itemIds = [...new Set(reviews.map((r) => r.itemId))];
  const docs = itemIds.length
    ? await Document.findAll({
        where: { id: { [Op.in]: itemIds } },
        attributes: ["id", "title", "documentName", "status", "deletedAt"],
      })
    : [];
  const docsById = new Map(docs.map((d) => [d.id, d]));

  const results = [] as Array<Record<string, unknown>>;
  for (const review of reviews) {
    const doc = docsById.get(review.itemId);
    // M4: skip trashed/deleted documents so they don't appear as live audit tasks.
    if (!doc || doc.deletedAt || doc.status === "TRASHED") continue;
    results.push({ ...review.get({ plain: true }), document: doc.get({ plain: true }) });
  }
  return results;
}

/**
 * Audit-stage register (rec §3.5): items audited, pass/flag, aging.
 * skip/take follow the same convention as documents.routes.ts (GET
 * /documents) — default page size 15, capped at 100 per page. This is the
 * only caller of this function (approvals.routes.ts GET /audit-reviews), so
 * unlike listUsers there's no unpaginated-consumer to preserve.
 */
export async function listAuditReviews(
  user: CurrentUser,
  filters: { status?: string; skip?: number; take?: number } = {},
) {
  const where: Record<string, unknown> = { tenantId: user.tenantId };
  if (filters.status) where.status = filters.status;
  const skip = filters.skip ?? 0;
  const take = Math.min(filters.take ?? 15, 100);
  const [data, total] = await Promise.all([
    AuditStageReview.findAll({
      where,
      include: [
        { model: User, as: "auditor", attributes: ["id", "firstName", "lastName", "email"] },
        { model: User, as: "assigner", attributes: ["id", "firstName", "lastName", "email"] },
      ],
      order: [["createdAt", "DESC"]],
      offset: skip,
      limit: take,
    }),
    AuditStageReview.count({ where }),
  ]);
  return { data, total, skip, take };
}
