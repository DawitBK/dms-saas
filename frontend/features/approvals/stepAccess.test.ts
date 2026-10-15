import { describe, expect, it } from 'vitest';
import type { ApprovalStepView, UserSummary } from './api';
import {
  canActOnStep, canDelegateStep, delegationCandidates, delegationText, escalationText, isAssignedTo, personName,
} from './stepAccess';

const user = (id: string, firstName = 'First', lastName = id): UserSummary => ({ id, firstName, lastName, email: `${id}@x.test` });

const step = (over: Partial<ApprovalStepView> = {}): ApprovalStepView => ({
  id: 's1', stepOrder: 1, stepType: 'APPROVE', assignedUserId: null, assignedRole: null, locked: false,
  slaHours: null, dueAt: null, status: 'PENDING', comment: null, decidedBy: null, decidedAt: null, ...over,
});

describe('personName', () => {
  it('is null-safe for a redacted user', () => {
    expect(personName(null)).toBe('—');
    expect(personName(undefined, 'Unassigned')).toBe('Unassigned');
    expect(personName(user('u1', 'Ada', 'Lovelace'))).toBe('Ada Lovelace');
  });
});

describe('isAssignedTo / canActOnStep', () => {
  it('matches a named assignee only', () => {
    const s = step({ assignedUserId: 'u1' });
    expect(isAssignedTo(s, 'u1')).toBe(true);
    expect(isAssignedTo(s, 'u2')).toBe(false);
    expect(isAssignedTo(s, null)).toBe(false);
  });

  it('matches a holder of a role step, but not a bare role-name match', () => {
    const s = step({ assignedRole: 'DEPT_MANAGER', roleHolders: [user('u1')] });
    expect(isAssignedTo(s, 'u1')).toBe(true);
    expect(isAssignedTo(s, 'u2')).toBe(false);
  });

  it('lets a person the step escalated to act on it, while the assignee keeps it', () => {
    const s = step({ assignedUserId: 'u1', escalatedAt: '2026-10-01T00:00:00Z', escalatedToUserIds: ['head'] });
    expect(canActOnStep(s, 'u1')).toBe(true);
    expect(canActOnStep(s, 'head')).toBe(true);
    expect(canActOnStep(s, 'other')).toBe(false);
  });
});

describe('canDelegateStep', () => {
  it('allows the assignee of a pending, unlocked, never-delegated step', () => {
    expect(canDelegateStep(step({ assignedUserId: 'u1' }), 'u1')).toBe(true);
  });
  it('refuses locked, already-delegated, non-pending and not-yours steps', () => {
    expect(canDelegateStep(step({ assignedUserId: 'u1', locked: true }), 'u1')).toBe(false);
    expect(canDelegateStep(step({ assignedUserId: 'u1', delegatedAt: '2026-10-01T00:00:00Z' }), 'u1')).toBe(false);
    expect(canDelegateStep(step({ assignedUserId: 'u1', status: 'WAITING' }), 'u1')).toBe(false);
    expect(canDelegateStep(step({ assignedUserId: 'u1' }), 'u2')).toBe(false);
  });
  it('does not let an escalated-to person delegate a step that is not theirs', () => {
    expect(canDelegateStep(step({ assignedUserId: 'u1', escalatedToUserIds: ['head'] }), 'head')).toBe(false);
  });
});

describe('delegationText / escalationText', () => {
  it('names who delegated and why, and tolerates a redacted delegator', () => {
    expect(delegationText(step())).toBeNull();
    expect(delegationText(step({ delegatedAt: 'x', delegatedByUser: user('u1', 'Ada', 'L'), delegationReason: 'on leave' })))
      .toBe('Delegated by Ada L (on leave)');
    expect(delegationText(step({ delegatedAt: 'x', delegatedByUser: null }))).toBe('Delegated by the original assignee');
  });

  it('lists who an overdue step escalated to, or says nobody was eligible', () => {
    expect(escalationText(step())).toBeNull();
    expect(escalationText(step({ escalatedAt: 'x', escalatedToUserIds: ['a', 'b'], escalatedToUsers: [user('a', 'Ann', 'A'), user('b', 'Bob', 'B')] })))
      .toBe('Escalated (overdue) - can also be decided by Ann A, Bob B');
    expect(escalationText(step({ escalatedAt: 'x', escalatedToUserIds: [], escalatedToUsers: [] }))).toBe('Escalated - nobody eligible');
  });
});

describe('delegationCandidates', () => {
  const everyone = [user('me'), user('sub'), user('a'), user('b')];
  it('drops the delegator and the submitter', () => {
    const out = delegationCandidates(step({ assignedUserId: 'me' }), everyone, 'me', 'sub');
    expect(out.map((u) => u.id)).toEqual(['a', 'b']);
  });
  it('limits a role step to holders of that role', () => {
    const out = delegationCandidates(step({ assignedRole: 'APPROVER', roleHolders: [user('me'), user('b')] }), everyone, 'me', 'sub');
    expect(out.map((u) => u.id)).toEqual(['b']);
  });
});
