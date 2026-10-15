// Pure rules the approval chain card uses to decide who may do what with a step, and how a step's
// delegation / escalation history reads. Kept out of the component so they can be tested and so the card's
// visibility checks stay in lock-step with what the backend accepts.
//
// The platform administrator is hidden: the server redacts them from `assignedUser`, `delegatedByUser`,
// `escalatedToUsers` and friends, so every name here may be null/undefined and must never crash the page.

import type { ApprovalStepView, UserSummary } from './api';

export function personName(user: Pick<UserSummary, 'firstName' | 'lastName'> | null | undefined, fallback = '—'): string {
  if (!user) return fallback;
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return name || fallback;
}

/** The person the step is assigned to: the named user, or a (department-scoped) holder of the assigned role. */
export function isAssignedTo(step: ApprovalStepView, userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (step.assignedUserId) return step.assignedUserId === userId;
  return Boolean(step.assignedRole && (step.roleHolders ?? []).some((h) => h.id === userId));
}

/** An overdue step is escalated to extra people (department head / approval admins) who may also decide it. */
export function isEscalatedTo(step: ApprovalStepView, userId: string | null | undefined): boolean {
  return Boolean(userId && (step.escalatedToUserIds ?? []).includes(userId));
}

/** May this person take a decision on the step (assignee, or somebody it was escalated to)? */
export function canActOnStep(step: ApprovalStepView, userId: string | null | undefined): boolean {
  return isAssignedTo(step, userId) || isEscalatedTo(step, userId);
}

/** Only the assignee may hand the step on; mandatory (locked) and already-delegated steps cannot be delegated. */
export function canDelegateStep(step: ApprovalStepView, userId: string | null | undefined): boolean {
  return step.status === 'PENDING' && !step.locked && !step.delegatedAt && isAssignedTo(step, userId);
}

/** "Delegated by Jane Doe (on leave)" — null when the step was never delegated. */
export function delegationText(step: ApprovalStepView): string | null {
  if (!step.delegatedAt) return null;
  const who = personName(step.delegatedByUser, 'the original assignee');
  const reason = step.delegationReason?.trim();
  return `Delegated by ${who}${reason ? ` (${reason})` : ''}`;
}

/** The escalation sentence for a pending step — null when it was never escalated. */
export function escalationText(step: ApprovalStepView): string | null {
  const names = (step.escalatedToUsers ?? []).map((u) => personName(u, '')).filter(Boolean);
  if (names.length > 0) return `Escalated (overdue) - can also be decided by ${names.join(', ')}`;
  if (step.escalatedAt || (step.escalatedToUserIds ?? []).length > 0) return 'Escalated - nobody eligible';
  return null;
}

/** Candidates for a delegation: never the delegator or the submitter; for a role step only holders of that role. */
export function delegationCandidates(
  step: ApprovalStepView,
  users: UserSummary[],
  currentUserId: string | null | undefined,
  submitterId: string | null | undefined,
): UserSummary[] {
  const roleHolderIds = step.assignedRole && !step.assignedUserId && (step.roleHolders ?? []).length > 0
    ? new Set((step.roleHolders ?? []).map((h) => h.id))
    : null;
  return users.filter((u) => u.id !== currentUserId && u.id !== submitterId && (!roleHolderIds || roleHolderIds.has(u.id)));
}
