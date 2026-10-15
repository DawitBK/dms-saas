// Step delegation (audit finding #23; SYSTEM-DECISIONS "delegation / out-of-office" follow-up).
//
// The person a step is assigned to (named, or a holder of the assigned role) may hand it to ONE other eligible user
// instead of leaving it to the overdue sweep. Safeguards, all enforced here and each pinned by a test:
//
//   * no escalation of rights -- the delegate must be someone the step could have been assigned to directly:
//       - an active member of the tenant holding approval:decide (assertStepIsActionable, which also refuses the
//         hidden platform administrator),
//       - inside the item's department (or reading across departments) so delegating never opens a document to a
//         person who could not already open it,
//       - for a role step, a holder of that same role,
//       - for an organisation-wide form template (no single department), an organisation-level role;
//   * never the delegator, never the item's author or submitter (self-approval stays impossible);
//   * mandatory (locked) template steps cannot be delegated -- the recipe named who must decide them; an approval
//     admin can still reassign them;
//   * a delegated step cannot be delegated again (no chains, no laundering);
//   * audited (APPROVAL_STEP_DELEGATED, with from / to / role / reason), the delegate and the submitter are notified,
//     and the delegate is granted read access to the item exactly like a reassignment (attachments included).
//
// Behind APPROVAL_DELEGATION_ENABLED (config/env.ts).

import { z } from "zod";
import { Op, QueryTypes } from "sequelize";
import { ApprovalChain, ApprovalStep, Document, User, sequelize } from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { config } from "../../config/env.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { fanOut } from "../notifications/notifications.service.js";
import { runInTransaction } from "../../shared/transaction.js";
import { requireLegalHoldClear } from "../../shared/documentGuards.js";
import { getResolvedRolePermissions } from "../roles/roles.service.js";
import { hasOrgWideTemplateAuthority } from "../forms/formTemplateScope.js";
import {
  ENGINE_STEP_RULES,
  assertRoleStepDepartmentScope,
  assertStepIsActionable,
  getUserDepartmentIds,
  hasPermission,
  normalizeApprovalDepartmentId,
  stepIsAssignedTo,
  type CurrentUser,
} from "./stepRules.js";
import {
  auditDocumentId,
  emitApprovalChainUpdated,
  getChain,
  grantChainParticipantAcl,
  isAuthorOrSubmitter,
  itemRefs,
  loadItem,
  type LoadedItem,
} from "./approvals.service.js";
import type { ApprovalItemType } from "../../infrastructure/database/index.js";

const delegateSchema = z.object({
  toUserId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(), // workflow_delegations.reason is VARCHAR(500)
});

/** Role names and the union of their (tenant-resolved) permissions for one user. */
async function rolesAndPermissions(userId: string, tenantId: string): Promise<{ roles: string[]; permissions: Set<string> }> {
  const rows = await sequelize.query<{ name: string }>(
    "SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = :userId",
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  const roles = (rows ?? []).map((r) => r.name);
  const permissionLists = await Promise.all(roles.map((name) => getResolvedRolePermissions(name, tenantId)));
  return { roles, permissions: new Set(permissionLists.flat() as string[]) };
}

/** The rules above that go beyond "may hold approval:decide". Throws 422 ERR-DELEGATE-OUT-OF-SCOPE. */
async function assertDelegateInScope(
  toUserId: string,
  step: { assignedRole: string | null },
  item: LoadedItem,
  tenantId: string,
): Promise<void> {
  const { roles, permissions } = await rolesAndPermissions(toUserId, tenantId);
  const outOfScope = (message: string) => new AppError(422, "ERR-DELEGATE-OUT-OF-SCOPE", message);

  if (step.assignedRole && !roles.includes(step.assignedRole))
    throw outOfScope("A step assigned to a role can only be delegated to another holder of that role");

  if (item.itemType === "FORM_TEMPLATE" && !item.departmentId && !hasOrgWideTemplateAuthority({ permissions: [...permissions] }))
    throw outOfScope("This form template applies to the whole organisation; it can only be delegated to an organisation-level approver");

  const scopeDeptId = await normalizeApprovalDepartmentId(tenantId, item.departmentId);
  if (scopeDeptId && !permissions.has(PERMISSIONS.DOCUMENT_READ_ALL)) {
    const deptIds = await getUserDepartmentIds(tenantId, toUserId);
    if (!deptIds.includes(scopeDeptId))
      throw outOfScope("The delegate must belong to this item's department — an approval admin can assign someone from elsewhere");
  }
}

export async function delegateStep(chainId: string, stepId: string, input: unknown, user: CurrentUser) {
  if (!config.APPROVAL_DELEGATION_ENABLED)
    throw new AppError(409, "ERR-DELEGATION-DISABLED", "Delegating approval steps is turned off for this installation");
  const { toUserId, reason } = delegateSchema.parse(input);

  const chain = await ApprovalChain.findOne({ where: { id: chainId, tenantId: user.tenantId } });
  if (!chain) throw new AppError(404, "ERR-CHAIN-NOT-FOUND", "Approval chain not found");
  if (chain.status !== "IN_REVIEW")
    throw new AppError(409, "ERR-CHAIN-STATE-INVALID", "Chain is not awaiting review (status " + chain.status + ")");
  const step = await ApprovalStep.findOne({ where: { id: stepId, chainId } });
  if (!step) throw new AppError(404, "ERR-STEP-NOT-FOUND", "Approval step not found");
  if (step.status !== "PENDING") throw new AppError(409, "ERR-STEP-NOT-PENDING", "This step is not awaiting a decision");
  // Only the assignee: not an escalatee (they may decide, not hand on), not an approval admin (they reassign).
  if (!stepIsAssignedTo(step, user))
    throw new AppError(403, "ERR-STEP-NOT-ASSIGNED", "Only the person this step is assigned to can delegate it");
  if (!hasPermission(user, PERMISSIONS.APPROVAL_DECIDE))
    throw new AppError(403, "ERR-PERMISSION-DENIED", "Missing permission: " + PERMISSIONS.APPROVAL_DECIDE);
  if (step.locked)
    throw new AppError(409, "ERR-STEP-LOCKED", "This is a mandatory step of the approval recipe and cannot be delegated — ask an approval admin to reassign it");
  if (step.delegatedAt)
    throw new AppError(409, "ERR-STEP-ALREADY-DELEGATED", "This step was already delegated to you and cannot be delegated again");
  if (toUserId === user.userId)
    throw new AppError(422, "ERR-DELEGATE-SELF", "You cannot delegate a step to yourself");

  const item = await loadItem(chain.itemType as ApprovalItemType, chain.itemId, user);
  if (item.documentId) {
    const doc = await Document.findByPk(item.documentId);
    if (doc) requireLegalHoldClear(doc);
  }
  await assertRoleStepDepartmentScope(step, user, user.tenantId, item.departmentId, ENGINE_STEP_RULES);

  if (isAuthorOrSubmitter(toUserId, chain.submittedBy, item.ownerId))
    throw new AppError(422, "ERR-STEP-SELF-APPROVAL", "You cannot delegate an approval step to the item's author or submitter");
  // Tenant member, active, holds approval:decide, and not the hidden platform administrator (404 like an unknown user).
  await assertStepIsActionable({ stepType: step.stepType, assignedUserId: toUserId }, user.tenantId, item.departmentId, ENGINE_STEP_RULES);
  await assertDelegateInScope(toUserId, step, item, user.tenantId);

  const fromRole = step.assignedRole;
  await runInTransaction(async (tx) => {
    const locked = await ApprovalChain.findOne({
      where: { id: chainId, tenantId: user.tenantId, status: "IN_REVIEW" },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!locked) throw new AppError(409, "ERR-CHAIN-STATE-INVALID", "This chain is not in review");
    // Status- and assignment-guarded: a concurrent decision, reassignment or second delegation wins cleanly.
    const [updated] = await ApprovalStep.update(
      {
        assignedUserId: toUserId,
        assignedRole: null,
        delegatedBy: user.userId,
        delegatedFromRole: fromRole,
        delegatedAt: new Date(),
        delegationReason: reason ?? null,
        // A delegation hands the step to one named person; earlier escalation co-deciders no longer apply.
        escalatedToUserIds: [],
      },
      {
        where: {
          id: stepId,
          chainId,
          status: "PENDING",
          delegatedAt: { [Op.is]: null },
          ...(step.assignedUserId ? { assignedUserId: step.assignedUserId } : { assignedRole: fromRole }),
        },
        transaction: tx,
      },
    );
    if (updated !== 1) throw new AppError(409, "ERR-STEP-NOT-PENDING", "This step changed while you were delegating it");
    await grantChainParticipantAcl(item.documentId, user.tenantId, user.userId, [{ assignedUserId: toUserId }], tx);
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_STEP_DELEGATED,
    userId: user.userId,
    userRole: user.role,
    documentId: auditDocumentId(item),
    actionDetails: {
      chainId,
      stepId,
      ...itemRefs(item),
      fromUserId: step.assignedUserId ?? user.userId,
      fromRole,
      toUserId,
      reason: reason ?? null,
    },
  });

  const delegator = await User.findByPk(user.userId, { attributes: ["firstName", "lastName"] });
  const fromName = delegator ? (delegator.firstName + " " + delegator.lastName).trim() : undefined;
  await fanOut({
    type: "APPROVAL_STEP_DELEGATED",
    tenantId: user.tenantId,
    recipientIds: [toUserId],
    severity: "INFO",
    payload: {
      chainId, stepId, stepType: step.stepType, itemType: chain.itemType, itemId: chain.itemId,
      documentId: item.documentId ?? undefined, title: item.title, fromName, reason: reason ?? null,
    },
  }).catch(() => {});
  await emitApprovalChainUpdated(chain.itemType as ApprovalItemType, chain.itemId, user.tenantId, item.departmentId, "delegated", [
    chain.submittedBy,
    toUserId,
  ]);
  return getChain(chain.itemType as ApprovalItemType, chain.itemId, user);
}
