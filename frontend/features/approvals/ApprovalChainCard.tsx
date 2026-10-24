'use client';

// Unified approval chain UI for a document (SYSTEM-DECISIONS.md D1–D7):
//  * author submits with the template pre-fill — swaps roles for named people,
//    adds/removes UNLOCKED steps; locked steps render with a lock and can't
//    be edited (D1);
//  * the chain renders as a stepper: done steps green with decision/comment/
//    time, the hot step highlighted "waiting on X", future steps grey; role
//    steps list the CURRENT holders with emails (D1 visibility);
//  * deciders get three buttons: Approve / Request changes / Decline —
//    decline demands a comment (D3);
//  * on the FINAL approve of an audit-policy type, the approver picks a named
//    auditor (D5/D6); auditors PASS/FLAG from here too (D7).

import { useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  CheckCircle2, ChevronRight, Circle, CircleDot, FileSignature, Forward, Lock, Send, ShieldCheck, Undo2, XCircle,
} from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { useAuthStore } from '../../state/auth.store';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useModalA11y } from '../../shared/hooks/useModalA11y';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { useAssignableRoles } from '../../shared/lib/assignmentAdvisory';
import {
  decideApprovalStep, decideAuditReview, delegateApprovalStep, getApprovalChain, getChainHistory, getRoleHolders,
  getSubmitPrefill, listAssignableDeciders, resubmitToAudit, submitForApproval,
  type ApprovalItemType, type ApprovalStepView, type UserSummary,
} from './api';
import { ApprovalStepsEditor, toSubmitSteps, type EditableStep } from './ApprovalStepsEditor';
import { approvalErrorMessage } from './errors';
import {
  canActOnStep, canDelegateStep, delegationCandidates, delegationText, escalationText, personName,
} from './stepAccess';

// Offline fallback only — the live list comes from
// GET /assignment-advisory/roles?permission=approval:decide, resolved per
// tenant, so a role customised via role:manage (or created at runtime) is
// offered here and accepted by submitForApproval instead of this array
// drifting from what assertStepIsActionable validates.
const ROLE_OPTIONS = ['DEPT_MANAGER', 'APPROVER', 'RECORDS_OFFICER', 'SYSTEM_ADMIN'];

// SignatureRequest-level statuses (not recipient-level) that mean a request
// is no longer actively in flight — 'draft'/'pending'/'sent'/'partially_signed'
// all mean someone already started or is actively running a ceremony, so only
// these terminal ones should let a PENDING_SIGNATURE document offer to start
// a fresh one (see esigning.service.ts's status vocabulary).
const TERMINAL_SIGNATURE_STATUSES = new Set(['completed', 'voided', 'expired']);

export type SignatureRequestSummary = {
  id: string;
  status: string;
  orderingMode: string;
  createdAt: string;
  recipients?: Array<{ id: string; name: string; email: string; status: string; orderIndex: number }>;
};

function safeDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '' : format(d, 'MMM d, yyyy HH:mm');
}

// Null-safe on purpose: the hidden platform administrator is redacted server side, so `assignedUser` can be null
// even for a step that is assigned.
function personLabel(step: ApprovalStepView): string {
  if (step.assignedUser) return `${personName(step.assignedUser)} (${step.assignedUser.email})`;
  if (step.assignedRole) {
    const holders = (step.roleHolders ?? []).map((h) => personName(h)).join(', ');
    return `${step.assignedRole.replace(/_/g, ' ')}${holders ? ` — current holders: ${holders}` : ''}`;
  }
  return 'no one (unassigned)';
}

export function ApprovalChainCard(props: {
  documentId: string;
  documentStatus: string;
  ownerId: string | null;
  auditPolicy?: 'required' | 'optional' | 'never';
  /** Defaults to DOCUMENT/documentId — pass FORM_INSTANCE + the instance id for a filled form, whose chain lives under its own item, not its backing document. */
  itemType?: ApprovalItemType;
  itemId?: string;
  /** E-signing ceremony for this document (Governance tab's data source) — folded into the same route view here so the full journey (approve → audit → sign) is visible in one place. */
  signatureRequests?: SignatureRequestSummary[];
  /** The item's own department, when the caller knows it. Only drives the
   *  non-blocking "this named approver is outside the department" advisory —
   *  omitting it simply suppresses that half of the warning, never changes
   *  who may be assigned. */
  departmentId?: string | null;
}) {
  const { documentId, documentStatus, ownerId, signatureRequests } = props;
  const auditPolicy = props.auditPolicy ?? 'never';
  const itemType = props.itemType ?? 'DOCUMENT';
  const itemId = props.itemId ?? documentId;
  const { userId, roles } = useAuthStore();
  const { can } = usePermissions();
  const queryClient = useQueryClient();

  const [submitOpen, setSubmitOpen] = useState(false);
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [decisionModal, setDecisionModal] = useState<{ step: ApprovalStepView; decision: 'APPROVE' | 'REQUEST_CHANGES' | 'DECLINE' } | null>(null);
  const [comment, setComment] = useState('');
  const [auditorUserId, setAuditorUserId] = useState('');
  const [auditModal, setAuditModal] = useState<{ reviewId: string; decision: 'PASS' | 'FLAG' } | null>(null);
  const [findings, setFindings] = useState('');
  const [resubmitAuditorId, setResubmitAuditorId] = useState('');
  // audit 2026-08-11 UI/UX sweep #3: "reassign a stuck step" and
  // "admin-cancel a chain" used native window.prompt()/window.confirm() —
  // unstyled, non-ARIA, outside the design system — while the functionally
  // identical letters recovery flow (letters/[id]/page.tsx) already uses a
  // real Modal with a picker + reason textarea. Ported that pattern here.
  const [reassignModal, setReassignModal] = useState<{ stepId: string } | null>(null);
  const [reassignTargetUserId, setReassignTargetUserId] = useState('');
  const [reassignReason, setReassignReason] = useState('');
  const [cancelChainModalOpen, setCancelChainModalOpen] = useState(false);
  const [cancelChainReason, setCancelChainReason] = useState('');
  // Delegation: the assignee hands their own pending step to another eligible person.
  const [delegateModal, setDelegateModal] = useState<{ step: ApprovalStepView } | null>(null);
  const [delegateTargetUserId, setDelegateTargetUserId] = useState('');
  const [delegateReason, setDelegateReason] = useState('');

  useModalA11y(Boolean(delegateModal), () => setDelegateModal(null));
  useModalA11y(submitOpen, () => setSubmitOpen(false));
  useModalA11y(Boolean(decisionModal), () => setDecisionModal(null));
  useModalA11y(Boolean(auditModal), () => setAuditModal(null));
  useModalA11y(Boolean(reassignModal), () => setReassignModal(null));
  useModalA11y(cancelChainModalOpen, () => setCancelChainModalOpen(false));

  const { data: chain, isError: chainAccessDenied } = useQuery({
    queryKey: ['approval-chain', itemType, itemId],
    queryFn: () => getApprovalChain(itemType, itemId),
    // A real (not-yet-submitted) chain, and a rejected fetch, both leave
    // `chain` undefined -- without distinguishing them, a document a viewer
    // has no department access to silently rendered "Not submitted yet",
    // implying no workflow exists at all rather than "you can't see it".
    retry: false,
  });

  // Previous submissions (UX gap): a CANCELLED chain, or one superseded by a
  // resubmission after DECLINE/CHANGES_REQUESTED, used to have no way to be
  // seen again once a newer chain existed — this fetches the full history so
  // that route is still visible instead of silently vanishing. Only needed
  // once something has actually been submitted.
  const { data: chainHistoryData } = useQuery({
    queryKey: ['approval-chain-history', itemType, itemId],
    queryFn: () => getChainHistory(itemType, itemId),
    enabled: Boolean(chain),
  });
  const previousChains = (chainHistoryData?.data ?? []).filter((c) => c.id !== chain?.id);
  const [historyOpen, setHistoryOpen] = useState(false);

  // H4: populate the named-person / auditor pickers from the approval-scoped
  // endpoint (reachable by submitters and deciders) instead of GET /users, which
  // requires USER_MANAGE and returned an empty list for the very people who need
  // to pick — making a `required`-audit document impossible to approve.
  const { data: decideUsersData } = useQuery({
    queryKey: ['assignable-users', 'decide'],
    queryFn: () => apiClient<{ data: UserSummary[] }>('/approvals/assignable-users?capability=decide'),
    enabled: can(PERMISSIONS.APPROVAL_SUBMIT) || can(PERMISSIONS.APPROVAL_DECIDE),
    staleTime: 60_000,
  });
  const users = decideUsersData?.data ?? [];

  const { data: auditorUsersData } = useQuery({
    queryKey: ['assignable-users', 'audit'],
    queryFn: () => apiClient<{ data: UserSummary[] }>('/approvals/assignable-users?capability=audit'),
    enabled: can(PERMISSIONS.APPROVAL_DECIDE),
    staleTime: 60_000,
  });
  const auditorUsers = auditorUsersData?.data ?? [];

  // Delegation candidates, scoped to the item's department when the caller knows it (the backend requires the
  // delegate to belong to it). Only fetched while the dialog is open.
  const { data: delegateUsersData, isLoading: delegateUsersLoading } = useQuery({
    queryKey: ['assignable-users', 'decide', props.departmentId ?? null],
    queryFn: () => listAssignableDeciders(props.departmentId),
    enabled: Boolean(delegateModal),
    staleTime: 30_000,
  });

  // H-UX-1: while the submit modal is open, resolve real names for every
  // ROLE_OPTIONS entry — covers both the prefilled steps AND any role the
  // submitter switches a step to via the dropdown, live.
  // departmentId makes the response say which of these roles has anyone able
  // to act on THIS item — otherwise a role queue with no holder in the item's
  // department is only refused after Submit (ERR-STEP-ROLE-UNSTAFFED).
  const { names: roleOptions, unstaffed: unstaffedRoles } = useAssignableRoles(
    PERMISSIONS.APPROVAL_DECIDE,
    ROLE_OPTIONS,
    props.departmentId,
  );
  /** Role-queue steps (no named person) whose role has nobody qualifying here. */
  const blockedSteps = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.assignedUserId && s.assignedRole && unstaffedRoles.has(s.assignedRole));
  const { data: roleHoldersData } = useQuery({
    queryKey: ['role-holders', roleOptions],
    queryFn: () => getRoleHolders(roleOptions),
    enabled: submitOpen && roleOptions.length > 0,
    staleTime: 60_000,
  });
  const roleHoldersMap = roleHoldersData?.data ?? {};

  // Auditors find their own pending review via THEIR queue endpoint
  // (audit-stage:decide) — the tenant-wide register needs workflow:read,
  // which the AUDITOR role deliberately doesn't hold.
  const { data: pendingAudit } = useQuery({
    queryKey: ['audit-review', documentId],
    queryFn: () => apiClient<{ data: Array<{ id: string; itemId: string; status: string; auditorUserId: string; assignedBy: string; findings: string | null }> }>('/approvals/my/audits'),
    enabled: ['PENDING_AUDIT', 'AUDIT_FLAGGED'].includes(documentStatus) && can(PERMISSIONS.AUDIT_STAGE_DECIDE),
  });
  const myAuditReview = (pendingAudit?.data ?? []).find((r) => r.itemId === documentId && r.status === 'PENDING');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['approval-chain', itemType, itemId] });
    queryClient.invalidateQueries({ queryKey: ['document', documentId] });
    queryClient.invalidateQueries({ queryKey: ['documents'] });
    queryClient.invalidateQueries({ queryKey: ['audit-review', documentId] });
    // This card is also used for FORM_TEMPLATE and FORM_INSTANCE chains
    // (forms/templates, forms/submissions pages) — without this, approving a
    // form template flipped it to 'active' in the DB immediately but the
    // templates list query (['forms','templates',...]) kept its stale
    // 'pending approval' badge until something else happened to refetch it,
    // making a successful approval look like it silently failed.
    queryClient.invalidateQueries({ queryKey: ['forms'] });
    queryClient.invalidateQueries({ queryKey: ['my-work'] });
    queryClient.invalidateQueries({ queryKey: ['my-work-count'] });
  };

  const openSubmit = async () => {
    try {
      const prefill = await getSubmitPrefill(itemType, itemId);
      setSteps(prefill.steps.map((s) => ({
        stepType: s.stepType,
        assignedRole: s.assignedRole ?? undefined,
        assignedUserId: s.assignedUserId ?? undefined,
        slaHours: s.slaHours ?? undefined,
        locked: s.locked ?? false,
        // Department-scoped (getSubmitPrefill resolves holders against this
        // item's own department, not tenant-wide like /approvals/role-holders
        // below) — carried through so the modal shows who can ACTUALLY act on
        // this item, not every tenant-wide holder of the role, which used to
        // invert the "no one holds this role" warning exactly when it mattered.
        roleHolders: s.roleHolders,
      })));
      setSubmitOpen(true);
    } catch (e) {
      toast.error(approvalErrorMessage(e, 'Could not load approval template'));
    }
  };

  const submitMut = useMutation({
    mutationFn: () => submitForApproval(itemType, itemId, toSubmitSteps(steps)),
    onSuccess: () => { toast.success('Submitted for approval'); setSubmitOpen(false); invalidate(); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Submit failed')),
  });

  const decideMut = useMutation({
    mutationFn: (vars: { stepId: string; decision: 'APPROVE' | 'REQUEST_CHANGES' | 'DECLINE'; comment?: string; auditorUserId?: string }) =>
      decideApprovalStep(chain!.id, vars.stepId, vars.decision, vars.comment, vars.auditorUserId),
    onSuccess: (res, vars) => {
      toast.success(vars.decision === 'APPROVE' ? 'Approved' : vars.decision === 'REQUEST_CHANGES' ? 'Returned for changes' : 'Declined');
      setDecisionModal(null); setComment(''); setAuditorUserId('');
      // FIX: decideApprovalStep already returns the post-decision chain —
      // write it straight into the cache instead of only invalidating and
      // waiting on a background refetch, so the stepper flips to the new
      // state (and, on the final step, the document's PENDING_SIGNATURE
      // banner appears) the instant this resolves rather than requiring a
      // manual reload to see what the server already committed.
      queryClient.setQueryData(['approval-chain', itemType, itemId], res);
      invalidate();
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Decision failed')),
  });

  const auditMut = useMutation({
    mutationFn: (vars: { reviewId: string; decision: 'PASS' | 'FLAG'; findings?: string }) =>
      decideAuditReview(vars.reviewId, vars.decision, vars.findings),
    onSuccess: (_r, vars) => {
      toast.success(vars.decision === 'PASS' ? 'Audit passed — item is archivable' : 'Flagged — returned to the final approver');
      setAuditModal(null); setFindings(''); invalidate();
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Audit decision failed')),
  });

  const resubmitAuditMut = useMutation({
    mutationFn: () => resubmitToAudit(documentId, resubmitAuditorId),
    onSuccess: () => { toast.success('Re-submitted to audit'); setResubmitAuditorId(''); invalidate(); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Re-submit failed')),
  });

  // Recovery levers (rec §1.7): stuck-step reassignment + admin cancel.
  const reassignMut = useMutation({
    mutationFn: (vars: { stepId: string; assignedUserId: string; reason: string }) =>
      apiClient(`/approvals/chains/${chain!.id}/steps/${vars.stepId}/reassign`, {
        method: 'POST',
        body: JSON.stringify({ assignedUserId: vars.assignedUserId, reason: vars.reason }),
      }),
    onSuccess: () => { toast.success('Step reassigned'); setReassignModal(null); setReassignTargetUserId(''); setReassignReason(''); invalidate(); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Reassign failed')),
  });

  const delegateMut = useMutation({
    mutationFn: (vars: { stepId: string; toUserId: string; reason: string }) =>
      delegateApprovalStep(chain!.id, vars.stepId, vars.toUserId, vars.reason),
    onSuccess: (res) => {
      toast.success('Step delegated');
      setDelegateModal(null); setDelegateTargetUserId(''); setDelegateReason('');
      // The endpoint returns the refreshed chain view — show it at once, then refresh everything that depends on it.
      if (res) queryClient.setQueryData(['approval-chain', itemType, itemId], res);
      invalidate();
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Delegate failed')),
  });

  const cancelChainMut = useMutation({
    mutationFn: (reason: string) =>
      apiClient(`/approvals/chains/${chain!.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => { toast.success('Chain cancelled — document returned to Draft'); setCancelChainModalOpen(false); setCancelChainReason(''); invalidate(); },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Cancel failed')),
  });

  const onDelegate = (step: ApprovalStepView) => {
    setDelegateTargetUserId('');
    setDelegateReason('');
    setDelegateModal({ step });
  };

  const onReassign = (stepId: string) => {
    setReassignTargetUserId('');
    setReassignReason('');
    setReassignModal({ stepId });
  };

  const submitReassign = () => {
    if (!reassignModal) return;
    if (!reassignTargetUserId) { toast.error('Pick a user to reassign to'); return; }
    if (reassignReason.trim().length < 10) { toast.error('A reason of at least 10 characters is required'); return; }
    reassignMut.mutate({ stepId: reassignModal.stepId, assignedUserId: reassignTargetUserId, reason: reassignReason.trim() });
  };

  const onCancelChain = () => {
    setCancelChainReason('');
    setCancelChainModalOpen(true);
  };

  const submitCancelChain = () => {
    if (cancelChainReason.trim().length < 10) { toast.error('A reason of at least 10 characters is required'); return; }
    cancelChainMut.mutate(cancelChainReason.trim());
  };

  const chainSteps = chain?.steps ?? [];
  const pendingStep = chainSteps.find((s) => s.status === 'PENDING');
  // Live-verified gap (2026-08-27 re-audit): a bare role-name match
  // (`roles.includes(s.assignedRole)`) is tenant-wide — it doesn't know this
  // step's role is department-scoped, so a DEPT_MANAGER outside the item's
  // department still saw themselves invited to decide, then hit
  // ERR-STEP-DEPT-SCOPE on click. `s.roleHolders` is the backend's own
  // department-scoped resolution of "who can actually act on this step"
  // (getChain -> resolveRoleHolders, same data personLabel() already
  // displays as "current holders") — checking membership in it instead
  // makes the button's visibility agree with what the backend will accept.
  // (stepAccess.ts, tested.) An ESCALATED step may also be decided by the people it was escalated to
  // (department head / approval admins) — the assignee keeps it, so both pass canActOnStep.
  const canDecide = pendingStep && canActOnStep(pendingStep, userId) && can(PERMISSIONS.APPROVAL_DECIDE) && chain?.status === 'IN_REVIEW';
  const canDelegate = Boolean(
    pendingStep && canDelegateStep(pendingStep, userId) && can(PERMISSIONS.APPROVAL_DECIDE) && chain?.status === 'IN_REVIEW',
  );
  const delegateCandidates = delegateModal
    ? delegationCandidates(delegateModal.step, delegateUsersData?.data ?? [], userId, chain?.submittedBy)
    : [];
  const isFinalStep = pendingStep && chainSteps.every((s) => s.stepOrder <= pendingStep.stepOrder || s.status !== 'WAITING');
  const needsAuditorPick = Boolean(decisionModal?.decision === 'APPROVE' && isFinalStep && auditPolicy !== 'never');

  const canSubmit =
    ['DRAFT', 'CHANGES_REQUESTED', 'DECLINED'].includes(documentStatus) &&
    can(PERMISSIONS.APPROVAL_SUBMIT) &&
    (!ownerId || ownerId === userId || can(PERMISSIONS.APPROVAL_ADMIN));

  const stepIcon = (s: ApprovalStepView) => {
    if (s.status === 'APPROVED') return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />;
    if (s.status === 'PENDING') return <CircleDot className="h-4 w-4 text-brand-600 shrink-0 animate-pulse" />;
    if (s.status === 'DECLINED') return <XCircle className="h-4 w-4 text-red-600 shrink-0" />;
    if (s.status === 'CHANGES_REQUESTED') return <Undo2 className="h-4 w-4 text-amber-600 shrink-0" />;
    return <Circle className="h-4 w-4 text-slate-300 shrink-0" />;
  };

  return (
    <div className="ui-card mt-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Approval chain
        </p>
        <span className="flex gap-2">
          {chain?.status === 'IN_REVIEW' && can(PERMISSIONS.APPROVAL_ADMIN) && (
            <button onClick={onCancelChain} disabled={cancelChainMut.isPending} className="ui-btn ui-btn-secondary text-xs"
              title="Admin override: cancel the running chain with a written reason">
              Cancel chain
            </button>
          )}
          {canSubmit && (
            <button onClick={openSubmit} className="ui-btn ui-btn-primary text-xs">
              <Send className="h-3.5 w-3.5" />
              {documentStatus === 'DRAFT' ? 'Submit for approval' : 'Resubmit for approval'}
            </button>
          )}
        </span>
      </div>

      {!chain && chainAccessDenied && (
        <p className="text-sm" style={{ color: '#d97706' }}>
          You don&apos;t have access to this item&apos;s approval workflow — it belongs to a department you&apos;re not a member of.
        </p>
      )}
      {!chain && !chainAccessDenied && <p className="text-sm text-text-muted">Not submitted yet — no approval chain exists for this document.</p>}

      {chain && (
        <>
          <p className="text-[12px] mb-3" style={{ color: 'var(--text-muted)' }}>
            Submitted by {chain.submitter ? `${chain.submitter.firstName} ${chain.submitter.lastName}` : '—'} on {safeDate(chain.submittedAt)}
            {chain.progress ? ` · ${chain.progress.done}/${chain.progress.total} approved` : ''}
          </p>
          {/* Full route, one connected timeline: approve/review steps → audit
              review → e-signing — every stop names who it's at, its status,
              and when it moved, so the whole journey reads at a glance. */}
          <ol className="relative space-y-2 border-l-2 pl-6 ml-2" style={{ borderColor: 'var(--border)' }}>
            {chainSteps.map((s) => (
              <li key={s.id} className="relative">
                <span className="absolute -left-[31px] top-2 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--surface)' }}>
                  {stepIcon(s)}
                </span>
                <div
                  className={`flex flex-wrap items-center gap-3 rounded-md px-3 py-2 ${s.status === 'PENDING' ? 'ring-1 ring-brand-400' : ''}`}
                  style={{ background: 'var(--surface-raised)' }}>
                  <span className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>#{s.stepOrder}</span>
                  <span className="text-[13px] font-medium">{s.stepType === 'APPROVE' ? 'Approve' : 'Review'}</span>
                  {s.locked && <Lock className="h-3 w-3 text-slate-400" aria-label="Mandatory step" />}
                  <span className="text-[12px] font-semibold">
                    {s.status === 'PENDING' ? 'Waiting on ' : 'Routed to '}{personLabel(s)}
                  </span>
                  {s.comment && <span className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>“{s.comment}”</span>}
                  {s.decidedAt && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{safeDate(s.decidedAt)}</span>}
                  {s.dueAt && s.status === 'PENDING' && (
                    <span className={`text-[11px] ${new Date(s.dueAt) < new Date() ? 'text-red-600 font-semibold' : ''}`} style={new Date(s.dueAt) < new Date() ? {} : { color: 'var(--text-muted)' }}>
                      due {safeDate(s.dueAt)}
                    </span>
                  )}
                  {delegationText(s) && (
                    <span className="text-[11px] font-medium text-brand-600" data-testid="step-delegated">{delegationText(s)}</span>
                  )}
                  {s.status === 'PENDING' && escalationText(s) && (
                    <span className="text-[11px] font-semibold text-red-600" data-testid="step-escalated">{escalationText(s)}</span>
                  )}
                  {s.status === 'PENDING' && !canDecide && can(PERMISSIONS.APPROVAL_ADMIN) && chain?.status === 'IN_REVIEW' && (
                    <button onClick={() => onReassign(s.id)} className="ml-auto ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"
                      title="Stuck-step recovery: hand this step to someone else (reason required)">
                      Reassign
                    </button>
                  )}
                  {s.status === 'PENDING' && canDecide && (
                    <span className="ml-auto flex flex-wrap gap-2">
                      {canDelegate && s.id === pendingStep?.id && (
                        <button onClick={() => onDelegate(s)} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"
                          title="Hand this step to another eligible person">
                          <Forward className="h-3.5 w-3.5" /> Delegate
                        </button>
                      )}
                      <button onClick={() => setDecisionModal({ step: s, decision: 'APPROVE' })} className="ui-btn ui-btn-primary !py-1 !px-2.5 text-[12px]">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button onClick={() => setDecisionModal({ step: s, decision: 'REQUEST_CHANGES' })} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]">
                        <Undo2 className="h-3.5 w-3.5" /> Request changes
                      </button>
                      <button onClick={() => setDecisionModal({ step: s, decision: 'DECLINE' })} className="ui-btn ui-btn-danger !py-1 !px-2.5 text-[12px]">
                        <XCircle className="h-3.5 w-3.5" /> Decline
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ))}

            {/* Audit stage (D5–D7): every review cycle this item has been
                through — FLAG-then-resubmit creates a new stop each time, so
                a document that bounced back and forth still shows its whole
                path, not just the latest attempt. */}
            {(chain.auditReviews ?? []).map((r) => (
              <li key={r.id} className="relative">
                <span className="absolute -left-[31px] top-2 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--surface)' }}>
                  {r.status === 'PASSED' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : r.status === 'FLAGGED' ? <XCircle className="h-4 w-4 text-red-600" /> : <CircleDot className="h-4 w-4 text-brand-600 animate-pulse" />}
                </span>
                <div className={`flex flex-wrap items-center gap-3 rounded-md px-3 py-2 ${r.status === 'PENDING' ? 'ring-1 ring-brand-400' : ''}`} style={{ background: 'var(--surface-raised)' }}>
                  <ShieldCheck className="h-3.5 w-3.5 text-brand-600 shrink-0" />
                  <span className="text-[13px] font-medium">Audit review</span>
                  <span className="text-[12px] font-semibold">
                    {r.status === 'PENDING' ? 'Waiting on ' : 'Reviewed by '}
                    {r.auditor ? `${r.auditor.firstName} ${r.auditor.lastName} (${r.auditor.email})` : 'unassigned auditor'}
                  </span>
                  {r.assigner && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>assigned by {r.assigner.firstName} {r.assigner.lastName}</span>}
                  {r.findings && <span className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>“{r.findings}”</span>}
                  {r.decidedAt && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{safeDate(r.decidedAt)}</span>}
                </div>
              </li>
            ))}

            {/* Audit stage preview: this document's type carries an audit
                policy, but no AuditStageReview row exists yet — that row is
                only created at the moment the final approver picks a named
                auditor (D6), so until then the whole audit stage was
                invisible even though it's a real, upcoming part of this
                document's pipeline. Shown so "every workflow this document
                will go through" reads as one list, not just whatever has
                already happened. */}
            {auditPolicy !== 'never' &&
              (chain.status === 'IN_REVIEW' || chain.status === 'CHANGES_REQUESTED') &&
              (chain.auditReviews ?? []).length === 0 && (
              <li className="relative">
                <span className="absolute -left-[31px] top-2 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--surface)' }}>
                  <Circle className="h-4 w-4 text-slate-300" />
                </span>
                <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                  <div className="flex flex-wrap items-center gap-3">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                    <span className="text-[13px] font-medium">Audit review</span>
                    <span className="text-[11px] uppercase font-bold" style={{ color: 'var(--text-muted)' }}>Not yet assigned</span>
                  </div>
                  <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {auditPolicy === 'required' ? 'This document type always goes through an audit stage' : 'This document type may go through an audit stage'} — the final approver picks the named auditor when they approve.
                  </p>
                </div>
              </li>
            )}

            {/* E-signing ceremony (D8) — same data the Governance tab shows,
                folded into the route so the full journey (approve → audit →
                sign) is visible without switching tabs. */}
            {(signatureRequests ?? []).map((req) => {
              const isDone = ['completed', 'signed'].includes(req.status.toLowerCase());
              const isDeclined = req.status.toLowerCase() === 'declined';
              return (
                <li key={req.id} className="relative">
                  <span className="absolute -left-[31px] top-2 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--surface)' }}>
                    {isDone ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : isDeclined ? <XCircle className="h-4 w-4 text-red-600" /> : <CircleDot className="h-4 w-4 text-brand-600 animate-pulse" />}
                  </span>
                  <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                    <div className="flex flex-wrap items-center gap-3">
                      <FileSignature className="h-3.5 w-3.5 text-brand-600 shrink-0" />
                      <span className="text-[13px] font-medium">E-signing</span>
                      <span className="text-[11px] uppercase font-bold" style={{ color: 'var(--text-muted)' }}>{req.status}</span>
                    </div>
                    {(req.recipients ?? []).length > 0 && (
                      <ul className="mt-1.5 ml-1.5 space-y-1">
                        {[...(req.recipients ?? [])].sort((a, b) => a.orderIndex - b.orderIndex).map((rec) => (
                          <li key={rec.id} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="font-mono text-[11px]">#{rec.orderIndex + 1}</span>
                            {rec.status === 'signed' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" /> : rec.status === 'declined' ? <XCircle className="h-3.5 w-3.5 text-red-600 shrink-0" /> : <Circle className="h-3.5 w-3.5 text-slate-300 shrink-0" />}
                            <span className="font-semibold">{rec.name}</span>
                            <span>({rec.email})</span>
                            <span className="uppercase font-bold text-[10px]">{rec.status}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}

            {/* D8's ceremony is a fully separate, manual step from approval —
                completing the chain only flips the document to
                PENDING_SIGNATURE, it never creates or sends a signature
                request itself (approvals.service.ts). Without this, a
                PENDING_SIGNATURE document with no signatureRequests yet just
                showed the approval step ending in silence, giving no hint
                that anything else was expected or who was supposed to act. */}
            {documentStatus === 'PENDING_SIGNATURE' &&
              !(signatureRequests ?? []).some((r) => !TERMINAL_SIGNATURE_STATUSES.has(r.status.toLowerCase())) && (
                <li className="relative">
                  <span className="absolute -left-[31px] top-2 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--surface)' }}>
                    <CircleDot className="h-4 w-4" style={{ color: 'var(--color-amber-500)' }} />
                  </span>
                  <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                    <div className="flex flex-wrap items-center gap-3">
                      <FileSignature className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--color-amber-500)' }} />
                      <span className="text-[13px] font-medium">E-signing</span>
                      <span className="text-[11px] uppercase font-bold" style={{ color: 'var(--color-amber-500)' }}>Not sent yet</span>
                    </div>
                    <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      This document requires a signature, but no signing request has been created — nothing is in progress and no one has been notified.
                    </p>
                    <Link
                      href={`/dashboard/signing?documentId=${documentId}`}
                      className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold"
                      style={{ color: 'var(--brand-600)' }}
                    >
                      <Send className="h-3 w-3" /> Start signing request
                    </Link>
                  </div>
                </li>
              )}
          </ol>

          {/* Previous submissions: a CANCELLED chain, or one superseded by a
              resubmission after DECLINE/CHANGES_REQUESTED, otherwise had no
              way to be seen again once this newer one existed. */}
          {previousChains.length > 0 && (
            <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={() => setHistoryOpen((o) => !o)}
                className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                <ChevronRight className={`h-3.5 w-3.5 transition-transform ${historyOpen ? 'rotate-90' : ''}`} />
                Previous submissions ({previousChains.length})
              </button>
              {historyOpen && (
                <ul className="mt-2 space-y-2">
                  {previousChains.slice().reverse().map((pc) => {
                    const outcomeStep = (pc.steps ?? []).find((s) => s.status === 'DECLINED' || s.status === 'CHANGES_REQUESTED');
                    return (
                      <li key={pc.id} className="rounded-md px-3 py-2 text-[12px]" style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)' }}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-bold uppercase text-[10px] px-1.5 py-0.5 rounded ${pc.status === 'DECLINED' ? 'text-red-600' : pc.status === 'CANCELLED' ? 'text-slate-500' : 'text-amber-600'}`}>
                            {pc.status.replace(/_/g, ' ')}
                          </span>
                          <span>Submitted by {pc.submitter ? `${pc.submitter.firstName} ${pc.submitter.lastName}` : '—'} on {safeDate(pc.submittedAt)}</span>
                          {pc.completedAt && <span>· closed {safeDate(pc.completedAt)}</span>}
                        </div>
                        {outcomeStep && (
                          <div className="mt-1">
                            {outcomeStep.status === 'DECLINED' ? 'Declined' : 'Changes requested'} by{' '}
                            {outcomeStep.decider ? `${outcomeStep.decider.firstName} ${outcomeStep.decider.lastName}` : 'unknown'}
                            {outcomeStep.comment && <span className="italic"> — “{outcomeStep.comment}”</span>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {/* Audit stage (D5–D7) */}
      {documentStatus === 'PENDING_AUDIT' && myAuditReview && myAuditReview.auditorUserId === userId && can(PERMISSIONS.AUDIT_STAGE_DECIDE) && (
        <div className="mt-4 p-3 rounded-md border border-brand-200" style={{ background: 'var(--surface-raised)' }}>
          <p className="text-[13px] font-semibold flex items-center gap-2 mb-2"><ShieldCheck className="h-4 w-4 text-brand-600" /> This document is pending your audit review</p>
          <div className="flex gap-2">
            <button onClick={() => setAuditModal({ reviewId: myAuditReview.id, decision: 'PASS' })} className="ui-btn ui-btn-primary text-xs">Pass — archivable</button>
            <button onClick={() => setAuditModal({ reviewId: myAuditReview.id, decision: 'FLAG' })} className="ui-btn ui-btn-danger text-xs">Flag with findings</button>
          </div>
        </div>
      )}

      {documentStatus === 'AUDIT_FLAGGED' && can(PERMISSIONS.APPROVAL_DECIDE) && (
        <div className="mt-4 p-3 rounded-md border border-amber-300" style={{ background: 'var(--surface-raised)' }}>
          <p className="text-[13px] font-semibold mb-2">Audit flagged this document — after remediation, re-submit it to audit:</p>
          <div className="flex gap-2 items-center">
            <select value={resubmitAuditorId} onChange={(e) => setResubmitAuditorId(e.target.value)} className="ui-input text-xs max-w-xs">
              <option value="">Pick an auditor…</option>
              {auditorUsers.filter((u) => u.id !== userId).map((u) => (
                <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
              ))}
            </select>
            <button disabled={!resubmitAuditorId || resubmitAuditMut.isPending} onClick={() => resubmitAuditMut.mutate()} className="ui-btn ui-btn-primary text-xs">
              Re-submit to audit
            </button>
          </div>
        </div>
      )}

      {/* Submit modal (D1: template pre-fill + author completion) */}
      {submitOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setSubmitOpen(false)} role="presentation" />
          <div className="relative ui-card max-w-2xl w-full max-h-[85vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="approval-submit-modal-title">
            <h3 id="approval-submit-modal-title" className="text-sm font-bold mb-1">Submit for approval</h3>
            <p className="text-xs text-text-muted mb-4">
              Steps run one at a time, top to bottom. Locked steps (<Lock className="h-3 w-3 inline" />) are mandated by the document type and cannot be changed. The final step must be an Approve.
            </p>
            <ApprovalStepsEditor
              steps={steps}
              onChange={setSteps}
              users={users}
              roleOptions={roleOptions}
              unstaffedRoles={unstaffedRoles}
              roleHoldersMap={roleHoldersMap}
              departmentId={props.departmentId}
              resourceType="document"
              // FORM_TEMPLATE's "documentId" is a template id, not a real
              // document — no ACL row to resolve, so only the department half
              // of the advisory runs.
              resourceId={itemType === 'FORM_TEMPLATE' ? null : documentId}
            />
            {blockedSteps.length > 0 && (
              <p className="mt-3 text-xs font-medium" style={{ color: 'var(--danger)' }}>
                {blockedSteps.length === 1 ? 'Step' : 'Steps'} {blockedSteps.map(({ i }) => i + 1).join(', ')}{' '}
                {blockedSteps.length === 1 ? 'is' : 'are'} assigned to a role with nobody in this item&apos;s
                department. Pick a named person, choose another role, or have that role granted here.
              </p>
            )}
            <div className="flex items-center justify-end mt-4">
              <div className="flex gap-2">
                <button onClick={() => setSubmitOpen(false)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
                <button onClick={() => submitMut.mutate()} disabled={submitMut.isPending || steps.length === 0 || blockedSteps.length > 0} className="ui-btn ui-btn-primary text-xs">
                  <Send className="h-3.5 w-3.5" /> Submit
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Decision modal (comment; auditor pick on final approve, D5/D6) */}
      {decisionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setDecisionModal(null)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="approval-decision-modal-title">
            <h3 id="approval-decision-modal-title" className="text-sm font-bold mb-2">
              {decisionModal.decision === 'APPROVE' ? 'Approve' : decisionModal.decision === 'REQUEST_CHANGES' ? 'Request changes' : 'Decline'}
            </h3>
            {decisionModal.decision === 'DECLINE' && (
              <p className="text-xs text-red-600 mb-2">Declining is a hard rejection — a written reason is required. The author may revise and resubmit.</p>
            )}
            {decisionModal.decision === 'REQUEST_CHANGES' && (
              <p className="text-xs text-text-muted mb-2">The item goes back to the author; the chain suspends until they resubmit.</p>
            )}
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={decisionModal.decision === 'APPROVE' ? 'Optional comment…' : 'Comment…'}
              className="ui-input w-full min-h-[80px] text-sm mb-3"
            />
            {needsAuditorPick && (
              <div className="mb-3">
                <label className="text-xs font-semibold block mb-1">
                  Audit stage — {auditPolicy === 'required' ? 'this type requires an auditor:' : 'optionally send to an auditor:'}
                </label>
                <select value={auditorUserId} onChange={(e) => setAuditorUserId(e.target.value)} className="ui-input w-full text-xs">
                  <option value="">{auditPolicy === 'required' ? 'Pick an auditor (required)…' : 'No audit needed'}</option>
                  {auditorUsers.filter((u) => u.id !== userId).map((u) => (
                    <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setDecisionModal(null)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
              <button
                disabled={decideMut.isPending || (decisionModal.decision === 'DECLINE' && !comment.trim()) || (needsAuditorPick && auditPolicy === 'required' && !auditorUserId)}
                onClick={() => decideMut.mutate({ stepId: decisionModal.step.id, decision: decisionModal.decision, comment: comment || undefined, auditorUserId: auditorUserId || undefined })}
                className={`ui-btn text-xs ${decisionModal.decision === 'DECLINE' ? 'ui-btn-danger' : 'ui-btn-primary'}`}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit decision modal (D7: FLAG requires findings) */}
      {auditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setAuditModal(null)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="audit-decision-modal-title">
            <h3 id="audit-decision-modal-title" className="text-sm font-bold mb-2">{auditModal.decision === 'PASS' ? 'Pass audit' : 'Flag with findings'}</h3>
            {auditModal.decision === 'FLAG' && (
              <p className="text-xs text-amber-700 mb-2">Findings are required — the item returns to the final approver, who owns the remediation.</p>
            )}
            <textarea
              value={findings}
              onChange={(e) => setFindings(e.target.value)}
              placeholder={auditModal.decision === 'PASS' ? 'Optional notes…' : 'Findings…'}
              className="ui-input w-full min-h-[80px] text-sm mb-3"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setAuditModal(null)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
              <button
                disabled={auditMut.isPending || (auditModal.decision === 'FLAG' && !findings.trim())}
                onClick={() => auditMut.mutate({ reviewId: auditModal.reviewId, decision: auditModal.decision, findings: findings || undefined })}
                className={`ui-btn text-xs ${auditModal.decision === 'FLAG' ? 'ui-btn-danger' : 'ui-btn-primary'}`}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delegate modal: the assignee hands their own pending step to another eligible person */}
      {delegateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="absolute inset-0" onClick={() => setDelegateModal(null)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="delegate-modal-title">
            <h3 id="delegate-modal-title" className="text-sm font-bold mb-2">Delegate step</h3>
            <p className="text-xs text-text-muted mb-3">
              Hand this step to someone else who can approve in this item&apos;s department. They take it over and decide it;
              a step can be delegated only once.
            </p>
            <label className="text-xs font-semibold block mb-1" htmlFor="delegate-target">Delegate to</label>
            <select id="delegate-target" value={delegateTargetUserId} onChange={(e) => setDelegateTargetUserId(e.target.value)} className="ui-input w-full text-xs mb-1">
              <option value="">{delegateUsersLoading ? 'Loading people…' : '— pick a person —'}</option>
              {delegateCandidates.map((u) => <option key={u.id} value={u.id}>{personName(u)} ({u.email})</option>)}
            </select>
            {!delegateUsersLoading && delegateCandidates.length === 0 && (
              <p className="text-xs mb-2" style={{ color: 'var(--color-amber-500)' }}>
                Nobody else is eligible to take this step right now. Ask an approval administrator to reassign it.
              </p>
            )}
            <label className="text-xs font-semibold block mb-1 mt-2" htmlFor="delegate-reason">Reason (optional)</label>
            <textarea
              id="delegate-reason"
              value={delegateReason}
              onChange={(e) => setDelegateReason(e.target.value)}
              maxLength={500}
              placeholder="e.g. On leave this week"
              className="ui-input w-full min-h-[70px] text-sm mb-3"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setDelegateModal(null)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
              <button
                disabled={delegateMut.isPending || !delegateTargetUserId}
                onClick={() => delegateMut.mutate({ stepId: delegateModal.step.id, toUserId: delegateTargetUserId, reason: delegateReason })}
                className="ui-btn ui-btn-primary text-xs"
              >
                Delegate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reassign modal (recovery lever: stuck-step reassignment) */}
      {reassignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setReassignModal(null)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="reassign-modal-title">
            <h3 id="reassign-modal-title" className="text-sm font-bold mb-2">Reassign step</h3>
            <p className="text-xs text-text-muted mb-3">Move this pending step to a different approval-capable user.</p>
            <label className="text-xs font-semibold block mb-1">Reassign to</label>
            <select value={reassignTargetUserId} onChange={(e) => setReassignTargetUserId(e.target.value)} className="ui-input w-full text-xs mb-3">
              <option value="">— pick a user —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>)}
            </select>
            <label className="text-xs font-semibold block mb-1">Reason (min 10 characters)</label>
            <textarea
              value={reassignReason}
              onChange={(e) => setReassignReason(e.target.value)}
              placeholder="Why is this step being reassigned?"
              className="ui-input w-full min-h-[80px] text-sm mb-3"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setReassignModal(null)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
              <button
                disabled={reassignMut.isPending || !reassignTargetUserId || reassignReason.trim().length < 10}
                onClick={submitReassign}
                className="ui-btn ui-btn-primary text-xs"
              >
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin cancel-chain modal (recovery lever: deadlocked chain override) */}
      {cancelChainModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setCancelChainModalOpen(false)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="cancel-chain-modal-title">
            <h3 id="cancel-chain-modal-title" className="text-sm font-bold mb-2">Cancel approval chain</h3>
            <p className="text-xs text-red-600 mb-3">Admin override — the document returns to Draft. This cannot be undone.</p>
            <label className="text-xs font-semibold block mb-1">Reason (min 10 characters)</label>
            <textarea
              value={cancelChainReason}
              onChange={(e) => setCancelChainReason(e.target.value)}
              placeholder="Why is this chain being cancelled?"
              className="ui-input w-full min-h-[80px] text-sm mb-3"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setCancelChainModalOpen(false)} className="ui-btn ui-btn-secondary text-xs">Back</button>
              <button
                disabled={cancelChainMut.isPending || cancelChainReason.trim().length < 10}
                onClick={submitCancelChain}
                className="ui-btn ui-btn-danger text-xs"
              >
                Cancel chain
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
