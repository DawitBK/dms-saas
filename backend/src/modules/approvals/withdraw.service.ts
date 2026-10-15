// The filer's own way out of a running approval (audit E7: "form instances cannot be edited").
//
// cancelChain is an approval-admin recovery tool. The person who filed a form (or submitted a document) also needs to
// take it BACK while it is under review -- to correct it, or because it was a mistake -- without asking an
// administrator. This recalls the item: the running chain is cancelled (open steps CANCELLED), the item returns to
// DRAFT so it can be edited (forms: PATCH /forms/instances/:id) and submitted again as a fresh chain. Nothing is
// deleted: the cancelled chain stays in the item's history.
//
// Only the item's author or the chain's submitter; never while a legal hold is in force; audited with the reason;
// the people the chain was waiting on are told it was withdrawn.

import { ApprovalChain, ApprovalStep, Document } from "../../infrastructure/database/index.js";
import { Op } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { fanOut } from "../notifications/notifications.service.js";
import { runInTransaction } from "../../shared/transaction.js";
import { requireLegalHoldClear } from "../../shared/documentGuards.js";
import type { ApprovalItemType } from "../../infrastructure/database/index.js";
import type { CurrentUser } from "./stepRules.js";
import {
  auditDocumentId,
  emitApprovalChainUpdated,
  getChain,
  itemRefs,
  loadItem,
  resolveRoleHolders,
} from "./approvals.service.js";

export async function withdrawOwnSubmission(
  itemType: Extract<ApprovalItemType, "DOCUMENT" | "FORM_INSTANCE">,
  itemId: string,
  reason: string | undefined,
  user: CurrentUser,
) {
  const item = await loadItem(itemType, itemId, user);
  const chain = await ApprovalChain.findOne({ where: { itemType, itemId, tenantId: user.tenantId, status: "IN_REVIEW" } });
  if (!chain) throw new AppError(409, "ERR-CHAIN-STATE-INVALID", "This item is not in review, so there is nothing to withdraw");
  if (chain.submittedBy !== user.userId && item.ownerId !== user.userId)
    throw new AppError(403, "ERR-NOT-ITEM-OWNER", "Only the person who filed this item can withdraw it from review");
  if (item.documentId) {
    const doc = await Document.findByPk(item.documentId);
    if (doc) requireLegalHoldClear(doc);
  }
  const cleanReason = reason?.trim() ? reason.trim().slice(0, 2000) : undefined;

  // Who the chain was waiting on, resolved BEFORE the steps are cancelled.
  const pending = await ApprovalStep.findOne({ where: { chainId: chain.id, status: "PENDING" }, order: [["stepOrder", "ASC"]] });
  let waitingOn: string[] = [];
  if (pending?.assignedUserId) waitingOn = [pending.assignedUserId];
  else if (pending?.assignedRole) {
    const byRole = await resolveRoleHolders([pending.assignedRole], user.tenantId, item.departmentId);
    waitingOn = (byRole.get(pending.assignedRole) ?? []).map((h) => h.id);
  }
  waitingOn = [...new Set([...waitingOn, ...(pending?.escalatedToUserIds ?? [])])].filter((id) => id !== user.userId);

  await runInTransaction(async (tx) => {
    const locked = await ApprovalChain.findOne({
      where: { id: chain.id, tenantId: user.tenantId, status: "IN_REVIEW" },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!locked) throw new AppError(409, "ERR-CHAIN-STATE-INVALID", "This item is no longer in review");
    await ApprovalStep.update(
      { status: "CANCELLED" },
      { where: { chainId: chain.id, status: { [Op.in]: ["PENDING", "WAITING"] } }, transaction: tx },
    );
    await locked.update({ status: "CANCELLED", completedAt: new Date() }, { transaction: tx });
    if (item.documentId) {
      const doc = await Document.findByPk(item.documentId, { transaction: tx });
      if (doc && doc.status === "IN_REVIEW") await doc.update({ status: "DRAFT", approvalStatus: "PENDING" }, { transaction: tx });
    }
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.FORM_INSTANCE_WITHDRAWN,
    userId: user.userId,
    userRole: user.role,
    documentId: auditDocumentId(item),
    actionDetails: { chainId: chain.id, ...itemRefs(item), reason: cleanReason ?? null, action: "withdrawn_from_review" },
  });
  if (waitingOn.length > 0) {
    await fanOut({
      type: "APPROVAL_WITHDRAWN",
      tenantId: user.tenantId,
      recipientIds: waitingOn,
      severity: "INFO",
      payload: { itemType, itemId, documentId: item.documentId ?? undefined, title: item.title, reason: cleanReason ?? null },
    }).catch(() => {});
  }
  await emitApprovalChainUpdated(itemType, itemId, user.tenantId, item.departmentId, "withdrawn", [chain.submittedBy, ...waitingOn]);
  return getChain(itemType, itemId, user);
}
