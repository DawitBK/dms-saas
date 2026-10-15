// Unified approval engine client (SYSTEM-DECISIONS.md D1–D7).
import { apiClient } from "../../shared/lib/apiClient";

export type ApprovalItemType = "DOCUMENT" | "FORM_TEMPLATE" | "FORM_INSTANCE";

export type UserSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Only GET /approvals/assignable-users returns this (it powers the
   *  cross-department advisory on the named-approver picker) — the embedded
   *  assignedUser/decider/roleHolders shapes omit it. */
  departments?: Array<{ id: string; name: string; code: string }>;
};

export type ApprovalStepView = {
  id: string;
  stepOrder: number;
  stepType: "REVIEW" | "APPROVE";
  assignedUserId: string | null;
  assignedRole: string | null;
  assignedUser?: UserSummary | null;
  roleHolders?: UserSummary[];
  locked: boolean;
  slaHours: number | null;
  dueAt: string | null;
  status: "WAITING" | "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "DECLINED" | "CANCELLED";
  comment: string | null;
  decidedBy: string | null;
  /** Null both when nobody has decided AND when the decider is the hidden platform administrator (redacted server side). */
  decider?: UserSummary | null;
  decidedAt: string | null;
  /** Set when the assignee handed this step to someone else (POST .../delegate). */
  delegatedBy?: string | null;
  /** For a role step: the role the step was assigned to before it was delegated to a named person. */
  delegatedFromRole?: string | null;
  delegatedAt?: string | null;
  delegationReason?: string | null;
  delegatedByUser?: UserSummary | null;
  /** Set when the step went overdue and was escalated. The assignee keeps the step; the escalated-to people may also decide it. */
  escalatedAt?: string | null;
  escalatedToUserIds?: string[];
  escalatedToUsers?: UserSummary[];
  slaBreachedAt?: string | null;
};

export type AuditReviewView = {
  id: string;
  status: "PENDING" | "PASSED" | "FLAGGED";
  auditorUserId: string;
  /** Null when the person is the hidden platform administrator (redacted server side). */
  auditor?: UserSummary | null;
  assignedBy: string;
  assigner?: UserSummary | null;
  findings: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type ApprovalChainView = {
  id: string;
  itemType: ApprovalItemType;
  itemId: string;
  status: "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "DECLINED" | "CANCELLED";
  /** Null when the submitter is the hidden platform administrator (redacted server side). */
  submittedBy: string | null;
  submitter?: UserSummary | null;
  submittedAt: string;
  completedAt: string | null;
  steps?: ApprovalStepView[];
  progress?: { done: number; total: number };
  auditReviews?: AuditReviewView[];
} | null;

export type PrefillStep = {
  stepOrder: number;
  stepType: "REVIEW" | "APPROVE";
  assignedRole?: string | null;
  assignedUserId?: string | null;
  locked?: boolean;
  slaHours?: number | null;
  roleHolders?: UserSummary[];
};

export type SubmitStepInput = {
  stepType: "REVIEW" | "APPROVE";
  assignedUserId?: string;
  assignedRole?: string;
  slaHours?: number;
};

export function getSubmitPrefill(itemType: ApprovalItemType, itemId: string) {
  return apiClient<{ templateId: string | null; templateName: string | null; steps: PrefillStep[] }>(
    `/approvals/prefill/${itemType}/${itemId}`,
  );
}

export function submitForApproval(itemType: ApprovalItemType, itemId: string, steps?: SubmitStepInput[]) {
  return apiClient<ApprovalChainView>(`/approvals/${itemType}/${itemId}/submit`, {
    method: "POST",
    body: JSON.stringify(steps && steps.length > 0 ? { steps } : {}),
  });
}

export function getApprovalChain(itemType: ApprovalItemType, itemId: string) {
  return apiClient<ApprovalChainView>(`/approvals/${itemType}/${itemId}/chain`);
}

/** Every chain this item has ever had, oldest first — including ones
 *  superseded by a later resubmission. getApprovalChain only ever returns
 *  the newest one. */
export function getChainHistory(itemType: ApprovalItemType, itemId: string) {
  return apiClient<{ data: NonNullable<ApprovalChainView>[] }>(`/approvals/${itemType}/${itemId}/chains`);
}

/** Current named holders of one or more roles — lets the submit UI show a
 *  real approver name instead of a bare role label.
 *
 *  Pass `departmentId` wherever the item's department is known. A role step is
 *  department-scoped at decide time, so the tenant-wide answer reports a role as
 *  staffed when nobody holds it where it matters — which is worse than no
 *  answer, because the author acts on it. */
export function getRoleHolders(roles: string[], departmentId?: string) {
  if (roles.length === 0) return Promise.resolve({ data: {} as Record<string, UserSummary[]> });
  const scope = departmentId ? `&departmentId=${encodeURIComponent(departmentId)}` : '';
  return apiClient<{ data: Record<string, UserSummary[]> }>(`/approvals/role-holders?roles=${roles.map(encodeURIComponent).join(',')}${scope}`);
}

export function decideApprovalStep(
  chainId: string,
  stepId: string,
  decision: "APPROVE" | "REQUEST_CHANGES" | "DECLINE",
  comment?: string,
  auditorUserId?: string,
) {
  return apiClient<ApprovalChainView>(`/approvals/chains/${chainId}/steps/${stepId}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, comment: comment || undefined, auditorUserId: auditorUserId || undefined }),
  });
}

/** The person a step is assigned to (named user, or a holder of the assigned role) hands it to another eligible
 *  person. Returns the refreshed chain view. Refused for locked steps and steps that were already delegated. */
export function delegateApprovalStep(chainId: string, stepId: string, toUserId: string, reason?: string) {
  return apiClient<ApprovalChainView>(`/approvals/chains/${chainId}/steps/${stepId}/delegate`, {
    method: 'POST',
    body: JSON.stringify({ toUserId, reason: reason?.trim() || undefined }),
  });
}

/** Candidates for a named person to decide an item. `departmentId` is the item's own department, when known. */
export function listAssignableDeciders(departmentId?: string | null) {
  const scope = departmentId ? `&departmentId=${encodeURIComponent(departmentId)}` : '';
  return apiClient<{ data: UserSummary[] }>(`/approvals/assignable-users?capability=decide${scope}`);
}

export function decideAuditReview(reviewId: string, decision: "PASS" | "FLAG", findings?: string) {
  return apiClient(`/approvals/audit-reviews/${reviewId}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, findings: findings || undefined }),
  });
}

export function resubmitToAudit(itemId: string, auditorUserId: string) {
  return apiClient(`/approvals/audit-reviews/items/${itemId}/resubmit`, {
    method: "POST",
    body: JSON.stringify({ auditorUserId }),
  });
}

/** A recipe (approval chain template). null departmentId + null orgUnitId = whole organisation; the most specific
 *  scope that matches wins at submit. Exactly one of documentTypeId / formTemplateId / forFormTemplates targets it. */
export type ApprovalChainTemplateView = {
  id: string;
  documentTypeId: string | null;
  formTemplateId: string | null;
  forFormTemplates?: boolean;
  departmentId?: string | null;
  orgUnitId?: string | null;
  name: string;
  steps: Array<{
    stepOrder?: number;
    stepType: 'REVIEW' | 'APPROVE';
    assignedRole?: string | null;
    assignedUserId?: string | null;
    locked?: boolean;
    slaHours?: number | null;
  }>;
  isActive: boolean;
  createdAt: string;
};

export type ScopeKind = 'organisation' | 'orgunit' | 'department';

/** Which of the three scope choices a recipe or form template with these ids represents (a department wins over an org unit). */
export function scopeKindOf(scope: { departmentId?: string | null; orgUnitId?: string | null }): ScopeKind {
  if (scope.departmentId) return 'department';
  if (scope.orgUnitId) return 'orgunit';
  return 'organisation';
}

export type MyWork = {
  /** Each item also carries `escalatedToMe: boolean` — true when an overdue step was escalated to the caller. */
  approvals: Array<Record<string, unknown> & { escalatedToMe?: boolean }>;
  signatures: Array<{ recipientId: string; requestId: string; status: string; createdAt: string; document: { id: string; title: string; documentName: string } | null }>;
  audits: Array<Record<string, unknown>>;
  letters: Array<Record<string, unknown>>;
};

export function getMyWork() {
  return apiClient<MyWork>(`/approvals/my/work`);
}
