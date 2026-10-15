// Unified approval engine routes (SYSTEM-DECISIONS.md D1–D7).
//
//   GET    /approvals/templates                       list chain templates (admin)
//   POST   /approvals/templates                       create/replace a type's template (admin)
//   GET    /approvals/prefill/:itemType/:itemId       pre-filled chain the author sees at submit
//   POST   /approvals/:itemType/:itemId/submit        author submits (self-service, D1)
//   GET    /approvals/:itemType/:itemId/chain         full chain view (visibility = item visibility, D9)
//   GET    /approvals/:itemType/:itemId/chains         every chain the item has ever had, oldest first (history)
//   POST   /approvals/chains/:chainId/steps/:stepId/decision   APPROVE / REQUEST_CHANGES / DECLINE
//   POST   /approvals/chains/:chainId/steps/:stepId/reassign   stuck-step recovery (admin)
//   POST   /approvals/chains/:chainId/steps/:stepId/delegate   the assignee hands the step to another eligible user
//   POST   /approvals/chains/:chainId/cancel                   admin cancel with reason
//   GET    /approvals/my/steps                        my pending approval steps (My Work)
//   GET    /approvals/my/audits                       my pending audit reviews (My Work)
//   POST   /approvals/audit-reviews/:reviewId/decision          PASS / FLAG (auditor)
//   POST   /approvals/audit-reviews/items/:itemId/resubmit      re-enter audit after remediation
//   GET    /approvals/audit-reviews                   audit-stage register
//   GET    /approvals/role-holders?roles=A,B          current named holders of one or more roles

import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { idempotent } from "../../shared/idempotency.middleware.js";
import { requirePermission, requireAnyPermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { AppError } from "../../core/AppError.js";
import {
  decideStep,
  getChain,
  getChainHistory,
  getSubmitPrefill,
  listAssignableUsers,
  listChainTemplates,
  deactivateChainTemplate,
  listMyPendingSteps,
  listRoleHolders,
  reassignStep,
  cancelChain,
  submitForApproval,
  upsertChainTemplate,
} from "./approvals.service.js";
import { delegateStep } from "./delegation.service.js";
import {
  decideAuditReview,
  listAuditReviews,
  listMyPendingAudits,
  reassignAuditor,
  resubmitToAudit,
} from "./auditStage.service.js";
import type { ApprovalItemType } from "../../infrastructure/database/index.js";

export const approvalsRoutes = Router();

const ITEM_TYPES = new Set(["DOCUMENT", "FORM_TEMPLATE", "FORM_INSTANCE"]);
function parseItemType(raw: string): ApprovalItemType {
  const upper = raw.toUpperCase();
  if (!ITEM_TYPES.has(upper))
    throw new AppError(422, "ERR-ITEM-TYPE-INVALID", `Unknown approval item type: ${raw}`);
  return upper as ApprovalItemType;
}

// ── Templates (admin) ─────────────────────────────────────────────────────────
approvalsRoutes.get(
  "/templates",
  requirePermission(PERMISSIONS.WORKFLOW_READ),
  asyncHandler(async (req, res) => {
    res.json({
      data: await listChainTemplates(req.user!, {
        documentTypeId: req.query.documentTypeId ? String(req.query.documentTypeId) : undefined,
        formTemplateId: req.query.formTemplateId ? String(req.query.formTemplateId) : undefined,
        forFormTemplates: req.query.forFormTemplates === "true" ? true : undefined,
      }),
    });
  }),
);

approvalsRoutes.post(
  "/templates",
  requirePermission(PERMISSIONS.WORKFLOW_MANAGE),
  asyncHandler(async (req, res) => {
    res.status(201).json(await upsertChainTemplate(req.body, req.user!));
  }),
);

approvalsRoutes.delete(
  "/templates/:id",
  requirePermission(PERMISSIONS.WORKFLOW_MANAGE),
  asyncHandler(async (req, res) => {
    res.json({ data: await deactivateChainTemplate(String(req.params.id), req.user!) });
  }),
);

// ── My Work queues ────────────────────────────────────────────────────────────
approvalsRoutes.get(
  "/my/work",
  requirePermission(PERMISSIONS.NOTIFICATION_READ),
  asyncHandler(async (req, res) => {
    const { getMyWork } = await import("./myWork.service.js");
    res.json(await getMyWork(req.user!));
  }),
);

approvalsRoutes.get(
  "/my/steps",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  asyncHandler(async (req, res) => {
    res.json({ data: await listMyPendingSteps(req.user!) });
  }),
);

approvalsRoutes.get(
  "/my/audits",
  requirePermission(PERMISSIONS.AUDIT_STAGE_DECIDE),
  asyncHandler(async (req, res) => {
    res.json({ data: await listMyPendingAudits(req.user!) });
  }),
);

// ── Audit stage ───────────────────────────────────────────────────────────────
approvalsRoutes.get(
  "/audit-reviews",
  requirePermission(PERMISSIONS.WORKFLOW_READ),
  asyncHandler(async (req, res) => {
    const result = await listAuditReviews(req.user!, {
      status: req.query.status ? String(req.query.status) : undefined,
      skip: req.query.skip !== undefined ? Number(req.query.skip) : undefined,
      take: req.query.take !== undefined ? Number(req.query.take) : undefined,
    });
    res.json(result);
  }),
);

approvalsRoutes.post(
  "/audit-reviews/:reviewId/decision",
  requirePermission(PERMISSIONS.AUDIT_STAGE_DECIDE),
  // A dropped response after a successful PASS/FLAG otherwise looks like a
  // "review not pending" 409 to the caller on retry — same class of bug as
  // letters.decideStep / esigning.signDocument (see idempotency.middleware.ts).
  idempotent("approvals.decideAuditReview"),
  asyncHandler(async (req, res) => {
    res.json(await decideAuditReview(String(req.params.reviewId), req.body, req.user!));
  }),
);

// M3: reassign a stuck PENDING audit review to a different auditor.
approvalsRoutes.post(
  "/audit-reviews/:reviewId/reassign",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  idempotent("approvals.reassignAuditor"),
  asyncHandler(async (req, res) => {
    const auditorUserId = String(req.body?.auditorUserId ?? "");
    res.json(await reassignAuditor(String(req.params.reviewId), auditorUserId, req.user!));
  }),
);

approvalsRoutes.post(
  "/audit-reviews/items/:itemId/resubmit",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  idempotent("approvals.resubmitToAudit"),
  asyncHandler(async (req, res) => {
    const auditorUserId = String(req.body?.auditorUserId ?? "");
    if (!auditorUserId)
      throw new AppError(422, "ERR-AUDITOR-REQUIRED", "auditorUserId is required");
    res.json(await resubmitToAudit(String(req.params.itemId), auditorUserId, req.user!));
  }),
);

// ── Assignee pickers (H4) ──────────────────────────────────────────────────────
// Minimal candidate list for the named-person / auditor dropdowns, reachable by
// submitters AND deciders (not just user:manage holders).
approvalsRoutes.get(
  "/assignable-users",
  requireAnyPermission(PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.AUDIT_STAGE_DECIDE),
  asyncHandler(async (req, res) => {
    const capability = String(req.query.capability ?? "decide") === "audit" ? "audit" : "decide";
    const departmentId = req.query.departmentId ? String(req.query.departmentId) : undefined;
    res.json({ data: await listAssignableUsers(req.user!, capability, departmentId) });
  }),
);

// Named-approver lookup (H-UX-1): resolves current holders of one or more
// roles, so the submit-for-approval UI can show real names, not just a role
// label, before the submitter confirms who each step is headed to.
approvalsRoutes.get(
  "/role-holders",
  requireAnyPermission(PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.APPROVAL_DECIDE),
  asyncHandler(async (req, res) => {
    const roles = String(req.query.roles ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    // Optional, and narrowing only — see listRoleHolders. Omitting it keeps the
    // previous tenant-wide answer, so existing callers are unaffected.
    const departmentId = typeof req.query.departmentId === "string" && req.query.departmentId ? req.query.departmentId : undefined;
    res.json({ data: await listRoleHolders(req.user!, roles, departmentId) });
  }),
);

// ── Chains ────────────────────────────────────────────────────────────────────
approvalsRoutes.get(
  "/prefill/:itemType/:itemId",
  requirePermission(PERMISSIONS.APPROVAL_SUBMIT),
  asyncHandler(async (req, res) => {
    res.json(await getSubmitPrefill(parseItemType(String(req.params.itemType)), String(req.params.itemId), req.user!));
  }),
);

approvalsRoutes.post(
  "/:itemType/:itemId/submit",
  requirePermission(PERMISSIONS.APPROVAL_SUBMIT),
  // A dropped response after a successful submit otherwise reads as "submit
  // failed" to the caller, who may then retry into a "document not in a
  // submittable state" 409 even though the first attempt actually went
  // through — see idempotency.middleware.ts.
  idempotent("approvals.submitForApproval"),
  asyncHandler(async (req, res) => {
    res.json(await submitForApproval(parseItemType(String(req.params.itemType)), String(req.params.itemId), req.body, req.user!));
  }),
);

approvalsRoutes.get(
  "/:itemType/:itemId/chain",
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    res.json(await getChain(parseItemType(String(req.params.itemType)), String(req.params.itemId), req.user!));
  }),
);

approvalsRoutes.get(
  "/:itemType/:itemId/chains",
  requirePermission(PERMISSIONS.DOCUMENT_READ),
  asyncHandler(async (req, res) => {
    res.json({ data: await getChainHistory(parseItemType(String(req.params.itemType)), String(req.params.itemId), req.user!) });
  }),
);

approvalsRoutes.post(
  "/chains/:chainId/steps/:stepId/decision",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  asyncHandler(async (req, res) => {
    res.json(await decideStep(String(req.params.chainId), String(req.params.stepId), req.body, req.user!));
  }),
);

approvalsRoutes.post(
  "/chains/:chainId/steps/:stepId/reassign",
  requirePermission(PERMISSIONS.APPROVAL_ADMIN),
  asyncHandler(async (req, res) => {
    res.json(await reassignStep(String(req.params.chainId), String(req.params.stepId), req.body, req.user!));
  }),
);

// Delegation: any decider can hand a step assigned to them to one other eligible user (delegation.service.ts has the
// rules). Not approval:admin, which is the separate reassign recovery above.
approvalsRoutes.post(
  "/chains/:chainId/steps/:stepId/delegate",
  requirePermission(PERMISSIONS.APPROVAL_DECIDE),
  idempotent("approvals.delegateStep"),
  asyncHandler(async (req, res) => {
    res.json(await delegateStep(String(req.params.chainId), String(req.params.stepId), req.body, req.user!));
  }),
);

approvalsRoutes.post(
  "/chains/:chainId/cancel",
  requirePermission(PERMISSIONS.APPROVAL_ADMIN),
  asyncHandler(async (req, res) => {
    res.json(await cancelChain(String(req.params.chainId), req.body?.reason, req.user!));
  }),
);
