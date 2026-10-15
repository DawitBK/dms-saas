'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import {
  ArrowLeft,
  Archive,
  CheckCircle2,
  Download,
  Eye,
  ExternalLink,
  History,
  Link2,
  Paperclip,
  PenLine,
  Printer,
  QrCode,
  Send,
  Trash2,
  Truck,
  Undo2,
  UserPlus,
  XCircle,
} from 'lucide-react';
import {
  acknowledgeDispatch,
  addLetterAttachment,
  archiveLetter,
  assignLetter,
  cancelLetter,
  recallLetter,
  decideStep,
  fetchLetterAttachmentBlobUrl,
  fetchLetterCoverSheetBlobUrl,
  fetchLetterPdfBlobUrl,
  getLetter,
  getLetterAssignableUsers,
  getLetterLinks,
  getLetterRevisionBody,
  linkLetters,
  listLetters,
  reassignStep,
  recordDispatch,
  removeLetterAttachment,
  resolveLetter,
  submitLetter,
  initiateLetterSigning,
  unlinkLetters,
  updateLetter,
} from '../../../../features/letters/api';
import type { LetterApprovalStep, LetterDetail } from '../../../../features/letters/types';
import type { LetterAssignableUser } from '../../../../features/letters/api';
import { apiClient } from '../../../../shared/lib/apiClient';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { StatusBadge } from '../../../../shared/components/ui/StatusBadge';
import { Modal } from '../../../../shared/components/Modal';
import { PdfBlobPreview } from '../../../../shared/components/PdfBlobPreview';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { useResetOnChange } from '../../../../shared/hooks/useResetOnChange';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { useAuthStore } from '../../../../state/auth.store';
import { AssignmentAdvisoryNotice } from '../../../../shared/components/AssignmentAdvisoryNotice';
import { useAssignableRoles } from '../../../../shared/lib/assignmentAdvisory';
import { LetterBodyEditor } from '../../../../shared/components/letterBody/LetterBodyEditor';
import { LetterBodyView } from '../../../../shared/components/letterBody/LetterBodyView';
import { letterErrorMessage } from '@/features/letters/errors';

function safeDate(value: unknown, fmt = 'dd MMM yyyy HH:mm'): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

const DISPATCH_CHANNELS = ['EMAIL', 'PORTAL', 'PRINT', 'COURIER', 'HAND_DELIVERY', 'REGISTERED_MAIL'] as const;
// Offline fallback only. The live lists come from
// GET /assignment-advisory/roles?permission=letter:review|letter:approve,
// which resolves each role's permissions PER TENANT — so a role customised
// via role:manage, or created at runtime via POST /roles, is offered here and
// accepted by submitLetter, instead of this array silently drifting from what
// the backend validates (RECORDS_OFFICER was missing from it for a long time
// even though submitLetter always accepted it).
const ROLES = ['DEPT_MANAGER', 'APPROVER', 'RECORDS_OFFICER', 'SYSTEM_ADMIN'];

type UserOption = { id: string; firstName: string; lastName: string; email: string };

/** A step's deadline. The clock is read once, lazily, so the badge is pure on re-render; it is only a hint, the server's sweep is what flags a breach. */
function DueBadge({ dueAt, breached }: { dueAt: string; breached: boolean }) {
  const [nowMs] = useState(() => Date.now());
  const overdue = breached || new Date(dueAt).getTime() < nowMs;
  return (
    <span
      className="text-[11px] font-semibold rounded px-1.5 py-0.5"
      style={overdue
        ? { background: 'var(--danger-bg, #fee2e2)', color: 'var(--danger, #b91c1c)' }
        : { background: 'var(--surface-sunken, #eef2f7)', color: 'var(--text-secondary)' }}
      title={`Deadline ${safeDate(dueAt)}`}
    >
      {overdue ? 'Overdue — was due ' : 'Due '}{safeDate(dueAt)}
    </span>
  );
}

export default function LetterDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const { userId, roles, role } = useAuthStore();

  const [decisionModal, setDecisionModal] = useState<{ step: LetterApprovalStep; decision: 'APPROVE' | 'RETURN' } | null>(null);
  const [reassignStepTarget, setReassignStepTarget] = useState<LetterApprovalStep | null>(null);
  const [reassignForm, setReassignForm] = useState({ assignedUserId: '', assignedRole: '', reason: '' });
  const [recallOpen, setRecallOpen] = useState(false);
  const [recallReason, setRecallReason] = useState('');
  const [adminCancelOpen, setAdminCancelOpen] = useState(false);
  const [adminCancelReason, setAdminCancelReason] = useState('');
  const [comment, setComment] = useState('');
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchForm, setDispatchForm] = useState({ channel: 'EMAIL', recipientName: '', recipientAddress: '', trackingReference: '', notes: '' });
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState('');
  const [linkForm, setLinkForm] = useState({ relatedLetterId: '', linkType: 'RELATED' as 'RELATED' | 'REPLY_TO' | 'FOLLOW_UP' });
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignForm, setAssignForm] = useState({ assignedToUserId: '', dueDate: '' });
  const [submitOpen, setSubmitOpen] = useState(false);
  // Default and only path: a single Approve step to the department manager.
  // Letters used to default to a two-step Review (Dept Manager) + Approve
  // (Approver) chain, but APPROVER isn't a role anyone actually holds
  // letter:approve/letter:review through in this tenant's role_permissions
  // (only DEPT_MANAGER is) — that second step was always going to show as
  // unstaffed. The modal no longer offers Review or Approver at all; see the
  // step-type/role rendering below.
  const [chainSteps, setChainSteps] = useState<Array<{ stepType: 'REVIEW' | 'APPROVE'; assignedRole: string; assignedUserId: string; slaHours: number | '' }>>([
    { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', assignedUserId: '', slaHours: '' },
  ]);
  // Who signs the letter once approval completes — 'default' (nothing
  // selected) keeps today's behavior: the final approver becomes the
  // signer. See letters.service.ts's enterPendingSignatureInTx.
  const [signOpen, setSignOpen] = useState(false);
  // No 'default' mode any more: the signatory is always an explicit choice on
  // the initiate-signing action, never inherited from whoever approved last.
  const [signatoryMode, setSignatoryMode] = useState<'user' | 'role'>('user');
  const [signatoryUserId, setSignatoryUserId] = useState('');
  const [signatoryRole, setSignatoryRole] = useState('DEPT_MANAGER');
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ subject: '', bodyHtml: '' });
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [coverSheetUrl, setCoverSheetUrl] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<{ id: string; url: string; filename: string } | null>(null);
  const [viewRevisionNo, setViewRevisionNo] = useState<number | null>(null);

  // STOR-3: none of these three blob URLs were ever revoked on navigation or
  // unmount — only on an explicit toggle/replace. Next's App Router reuses
  // this same page component across [id] navigations, so opening Letter A,
  // previewing it, then navigating straight to Letter B without clicking
  // "Hide" used to leave Letter A's actual PDF rendering under Letter B's
  // header until manually toggled — a stale-content bug, not just a leak.
  // Refs (not state) so the cleanup effect below always sees the latest
  // value without a stale closure, matching signing/pending/page.tsx's
  // existing cancelled-flag/cleanup pattern for the same fetch-then-blob shape.
  const pdfUrlRef = useRef<string | null>(null);
  const coverSheetUrlRef = useRef<string | null>(null);
  const attachmentPreviewRef = useRef<{ id: string; url: string; filename: string } | null>(null);

  // Clears the VISIBLE state synchronously during render, the instant `id`
  // changes — before React ever paints, so Letter A's content cannot flash
  // under Letter B's header even for one frame (see useResetOnChange's own
  // doc comment for why this must be a render-time adjustment, not an
  // effect). The actual URL.revokeObjectURL calls happen in the effect
  // below; this only clears what's on screen.
  useResetOnChange([id], () => {
    setPdfUrl(null);
    setCoverSheetUrl(null);
    setAttachmentPreview(null);
  });

  // Revokes whatever blob URLs are actually live, on id change AND on
  // unmount (a cleanup function fires for both) — closing the memory-leak
  // half of the bug, distinct from useResetOnChange's visual-state half above.
  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      if (coverSheetUrlRef.current) URL.revokeObjectURL(coverSheetUrlRef.current);
      if (attachmentPreviewRef.current) URL.revokeObjectURL(attachmentPreviewRef.current.url);
      pdfUrlRef.current = null;
      coverSheetUrlRef.current = null;
      attachmentPreviewRef.current = null;
    };
  }, [id]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['letter', `${userId}:${role}`, id],
    queryFn: () => getLetter(id),
    enabled: Boolean(id && userId),
    retry: 1,
  });
  const letter = data?.data;

  const { data: linksData } = useQuery({
    queryKey: ['letter-links', id],
    queryFn: () => getLetterLinks(id),
    enabled: Boolean(id && letter),
  });

  const { data: usersData } = useQuery({
    queryKey: ['users', 'letter-assignees'],
    queryFn: () => apiClient<{ data: UserOption[] }>('/users'),
    // Used by the reassign-step admin recovery only (dept managers may not
    // hold user:manage; a 403 just leaves that picker empty — role
    // reassignment still works). The submit-chain modal's own pickers below
    // use GET /letters/assignable-users instead, which an ordinary drafter
    // can always reach.
    enabled: can(PERMISSIONS.USER_MANAGE) || can(PERMISSIONS.DEPT_MANAGE) || can(PERMISSIONS.ACL_BYPASS_ADMIN),
    staleTime: 60_000,
  });

  // Named-person candidates for the submit-chain modal — reachable by any
  // letter drafter/reviewer/approver, unlike usersData above.
  const { data: reviewAssignees } = useQuery({
    queryKey: ['letters', 'assignable-users', 'REVIEW'],
    queryFn: () => getLetterAssignableUsers('REVIEW'),
    enabled: submitOpen,
    staleTime: 60_000,
  });
  const { data: approveAssignees } = useQuery({
    queryKey: ['letters', 'assignable-users', 'APPROVE'],
    queryFn: () => getLetterAssignableUsers('APPROVE'),
    enabled: submitOpen,
    staleTime: 60_000,
  });
  const { data: delegateAssignees } = useQuery({
    queryKey: ['letters', 'assignable-users', 'delegate', reassignStepTarget?.stepType ?? 'APPROVE'],
    queryFn: () => getLetterAssignableUsers(reassignStepTarget?.stepType === 'REVIEW' ? 'REVIEW' : 'APPROVE'),
    enabled: Boolean(reassignStepTarget) && !can(PERMISSIONS.DEPT_MANAGE) && !can(PERMISSIONS.ACL_BYPASS_ADMIN),
    staleTime: 60_000,
  });
  const { data: signatoryAssignees } = useQuery({
    queryKey: ['letters', 'assignable-users', 'SIGNATORY'],
    queryFn: () => getLetterAssignableUsers('SIGNATORY'),
    enabled: signOpen,
    staleTime: 60_000,
  });
  const assigneesByStepType: Record<'REVIEW' | 'APPROVE', LetterAssignableUser[]> = {
    REVIEW: reviewAssignees?.data ?? [],
    APPROVE: approveAssignees?.data ?? [],
  };

  // Role options, resolved per tenant so the dropdown can never offer a role
  // submitLetter/reassignStep will then reject with ERR-STEP-ROLE-INVALID.
  //
  // Passing this letter's department also answers the OTHER reason submit gets
  // refused — ERR-STEP-ROLE-UNSTAFFED, "no active user holding role X is a
  // member of this letter's department". That was previously only discoverable
  // by pressing Submit and reading a toast: the role list was department-blind,
  // so a letter filed to a department with no DEPT_MANAGER still offered
  // DEPT_MANAGER as the default first step. `unstaffed` names the roles the
  // backend would reject, computed by the very same predicate the validator
  // uses (stepRules.ts's resolveRoleStepEligibility).
  // `letter` is still possibly-undefined here: the loading guard is further
  // down, and these are hooks, so they cannot move below it.
  const deptId = letter?.department?.id;
  const { names: reviewRoles, unstaffed: reviewUnstaffed } = useAssignableRoles(PERMISSIONS.LETTER_REVIEW, ROLES, deptId);
  const { names: approveRoles, unstaffed: approveUnstaffed } = useAssignableRoles(PERMISSIONS.LETTER_APPROVE, ROLES, deptId);
  const rolesByStepType: Record<'REVIEW' | 'APPROVE', string[]> = { REVIEW: reviewRoles, APPROVE: approveRoles };
  const unstaffedByStepType: Record<'REVIEW' | 'APPROVE', Set<string>> = { REVIEW: reviewUnstaffed, APPROVE: approveUnstaffed };
  // A signatory is held to no LETTER_* permission at all (assertSignatoryIsValid
  // only requires ≥1 active department-scoped holder), so this list isn't filtered.
  const { names: signatoryRoles, unstaffed: signatoryUnstaffed } = useAssignableRoles(undefined, ROLES, deptId);
  const deptLabel = letter?.department?.name ?? 'this department';

  /** Steps that would be refused: a ROLE QUEUE step (no named person) whose
   *  role has no qualifying holder here. Named assignees are exempt — they are
   *  validated as people, not through department membership. */
  const blockedSteps = chainSteps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.assignedUserId && unstaffedByStepType[s.stepType].has(s.assignedRole));

  /** Same rule for the reassign dialog: reassignStep re-runs
   *  assertStepIsActionable, so a role queue with no holder here is refused
   *  there too. Only applies when a ROLE was picked, not a named person. */
  const reassignRoleUnstaffed = Boolean(
    reassignStepTarget &&
      !reassignForm.assignedUserId &&
      reassignForm.assignedRole &&
      unstaffedByStepType[reassignStepTarget.stepType].has(reassignForm.assignedRole),
  );

  const { data: linkCandidates } = useQuery({
    queryKey: ['letters', 'link-picker', linkSearch],
    queryFn: () => listLetters({ q: linkSearch, take: 8 }),
    enabled: linkOpen && linkSearch.trim().length >= 2,
  });

  const { data: revisionData, isLoading: revisionLoading } = useQuery({
    queryKey: ['letter-revision', id, viewRevisionNo],
    queryFn: () => getLetterRevisionBody(id, viewRevisionNo!),
    enabled: Boolean(id && viewRevisionNo !== null),
    staleTime: Infinity, // revisions are immutable
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['letter'] });
    queryClient.invalidateQueries({ queryKey: ['letters'] });
    queryClient.invalidateQueries({ queryKey: ['letter-links', id] });
    queryClient.invalidateQueries({ queryKey: ['letter-volume-report'] });
    queryClient.invalidateQueries({ queryKey: ['my-work'] });
    queryClient.invalidateQueries({ queryKey: ['my-work-count'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
    queryClient.invalidateQueries({ queryKey: ['documents'] });
    queryClient.invalidateQueries({ queryKey: ['documents-list'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
  };

  // FIX: every action below (approve, return, cancel, archive, ...) already
  // gets the fresh letter back in its response body, but used to rely
  // entirely on invalidate()'s background refetch to get it onto the screen
  // — leaving a window (slow network, a refetch that quietly errors, a
  // request that lands out of order) where the mutation has genuinely
  // succeeded server-side but this page keeps rendering the pre-mutation
  // letter until something else happens to remount it (a manual refresh).
  // Writing the response straight into the query cache makes the update
  // synchronous and independent of the refetch actually completing;
  // invalidate() still runs alongside it so list views and other tabs pick
  // up the change too.
  const setLetterCache = (res: { data: LetterDetail }) => {
    queryClient.setQueryData(['letter', `${userId}:${role}`, id], res);
  };

  // Submitting for approval carries APPROVERS only. Choosing who signs is a
  // separate action (initiateSignMut below) — it used to be smuggled into this
  // payload, which is why a chosen signatory was handed an approval task.
  const submitMut = useMutation({
    mutationFn: () =>
      submitLetter(
        id,
        chainSteps.map((s) => ({ stepType: s.stepType, assignedRole: s.assignedUserId ? undefined : s.assignedRole, assignedUserId: s.assignedUserId || undefined, slaHours: s.slaHours || undefined })),
      ),
    onSuccess: (res) => { toast.success('Submitted for approval'); setSubmitOpen(false); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Submit failed')),
  });

  // The second, separate action: approval is complete, now choose who signs.
  const initiateSignMut = useMutation({
    mutationFn: () =>
      initiateLetterSigning(
        id,
        signatoryMode === 'role' ? { assignedRole: signatoryRole } : { assignedUserId: signatoryUserId },
      ),
    onSuccess: (res) => {
      toast.success('Sent for signature');
      setSignOpen(false);
      setLetterCache(res);
      invalidate();
    },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Could not start signing')),
  });
  const decideMut = useMutation({
    mutationFn: ({ stepId, decision, c }: { stepId: string; decision: 'APPROVE' | 'RETURN'; c?: string }) =>
      decideStep(id, stepId, decision, c),
    onSuccess: (res, vars) => {
      toast.success(vars.decision === 'APPROVE' ? 'Approved' : 'Returned for correction');
      setDecisionModal(null); setComment(''); setLetterCache(res); invalidate();
    },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Decision failed')),
  });
  const reassignMut = useMutation({
    mutationFn: () =>
      reassignStep(id, reassignStepTarget!.id, {
        assignedUserId: reassignForm.assignedUserId || undefined,
        assignedRole: reassignForm.assignedUserId ? undefined : reassignForm.assignedRole || undefined,
        reason: reassignForm.reason.trim() || undefined,
      }),
    onSuccess: (res) => { toast.success(canDelegate ? 'Step delegated' : 'Step reassigned'); setReassignStepTarget(null); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Reassign failed')),
  });
  const cancelMut = useMutation({
    mutationFn: () => cancelLetter(id),
    onSuccess: (res) => { toast.success('Letter cancelled'); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Cancel failed')),
  });
  const recallMut = useMutation({
    mutationFn: () => recallLetter(id, recallReason.trim() || undefined),
    onSuccess: (res) => { toast.success('Letter recalled — you can edit it and submit again'); setRecallOpen(false); setRecallReason(''); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Recall failed')),
  });
  const adminCancelMut = useMutation({
    mutationFn: () => cancelLetter(id, adminCancelReason.trim()),
    onSuccess: (res) => { toast.success('Letter cancelled (admin override)'); setAdminCancelOpen(false); setAdminCancelReason(''); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Cancel failed')),
  });
  const archiveMut = useMutation({
    mutationFn: () => archiveLetter(id),
    onSuccess: (res) => { toast.success('Letter archived'); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Archive failed')),
  });
  const dispatchMut = useMutation({
    mutationFn: () => recordDispatch(id, dispatchForm),
    onSuccess: () => { toast.success('Dispatch recorded'); setDispatchOpen(false); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Dispatch failed')),
  });
  const acknowledgeMut = useMutation({
    mutationFn: (dispatchId: string) => acknowledgeDispatch(id, dispatchId),
    onSuccess: () => { toast.success('Acknowledgment recorded'); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Acknowledgment failed')),
  });
  const linkMut = useMutation({
    mutationFn: () => linkLetters(id, linkForm.relatedLetterId, linkForm.linkType),
    onSuccess: () => { toast.success('Letters linked'); setLinkOpen(false); setLinkSearch(''); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Link failed')),
  });
  const unlinkMut = useMutation({
    mutationFn: (linkId: string) => unlinkLetters(id, linkId),
    onSuccess: () => { toast.success('Link removed'); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Unlink failed')),
  });
  const assignMut = useMutation({
    mutationFn: () => assignLetter(id, assignForm.assignedToUserId || null, assignForm.dueDate || null),
    onSuccess: (res) => { toast.success('Incoming letter routing updated'); setAssignOpen(false); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Assignment failed')),
  });
  const resolveMut = useMutation({
    mutationFn: (status: 'RESPONDED' | 'CLOSED') => resolveLetter(id, status),
    onSuccess: (res, status) => { toast.success(status === 'RESPONDED' ? 'Marked responded' : 'Closed'); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Update failed')),
  });
  const saveMut = useMutation({
    mutationFn: () => updateLetter(id, { subject: editForm.subject, bodyHtml: editForm.bodyHtml }),
    onSuccess: (res) => { toast.success('Draft updated'); setEditing(false); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Save failed')),
  });
  const addAttachmentMut = useMutation({
    mutationFn: (file: File) => addLetterAttachment(id, file),
    onSuccess: (res) => {
      // WARN-UNSCANNED is fail-open (never blocking) — same amber-toast
      // treatment as the document upload paths, not a plain success.
      if (res.data.warnings?.includes('WARN-UNSCANNED')) {
        toast(
          'Attachment added — but it could not be scanned for viruses. It was still allowed through and is flagged for review.',
          {
            icon: '⚠️',
            duration: 8000,
            style: { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' },
          },
        );
      } else {
        toast.success('Attachment added');
      }
      setLetterCache(res);
      invalidate();
    },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Attachment upload failed')),
  });
  const removeAttachmentMut = useMutation({
    mutationFn: (attachmentId: string) => removeLetterAttachment(id, attachmentId),
    onSuccess: (res) => { toast.success('Attachment removed'); setLetterCache(res); invalidate(); },
    onError: (e: unknown) => toast.error(letterErrorMessage(e, 'Failed to remove attachment')),
  });
  const downloadAttachment = async (attachmentId: string, filename: string) => {
    try {
      const url = await fetchLetterAttachmentBlobUrl(id, attachmentId);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
    } catch (e) {
      toast.error(letterErrorMessage(e, 'Download failed'));
    }
  };

  // Browsers render these inline via an <iframe> (native PDF viewer / image
  // decoder); anything else (Word, Excel, ...) would just silently trigger a
  // download inside the frame or show a blank pane, so those fall back to the
  // explicit download button instead of a broken "preview".
  const isPreviewableAttachment = (filename: string): boolean =>
    /\.(pdf|png|jpe?g|gif|webp)$/i.test(filename);

  const previewAttachment = async (attachmentId: string, filename: string) => {
    if (attachmentPreview?.id === attachmentId) {
      URL.revokeObjectURL(attachmentPreview.url);
      attachmentPreviewRef.current = null;
      setAttachmentPreview(null);
      return;
    }
    try {
      const url = await fetchLetterAttachmentBlobUrl(id, attachmentId);
      const next = { id: attachmentId, url, filename };
      attachmentPreviewRef.current = next;
      setAttachmentPreview((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return next;
      });
    } catch (e) {
      toast.error(letterErrorMessage(e, 'Preview failed'));
    }
  };

  const loadPdf = async () => {
    try {
      const url = await fetchLetterPdfBlobUrl(id);
      pdfUrlRef.current = url;
      setPdfUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      return url;
    } catch (e) {
      toast.error(letterErrorMessage(e, 'PDF failed'));
      return null;
    }
  };

  const downloadPdf = async () => {
    const url = pdfUrl ?? await loadPdf();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(letter?.referenceNumber ?? 'letter').replace(/\//g, '-')}.pdf`;
    a.click();
  };

  const printPdf = async () => {
    const url = pdfUrl ?? await loadPdf();
    if (!url) return;
    const w = window.open(url, '_blank');
    w?.addEventListener('load', () => w.print(), { once: true });
  };

  const loadCoverSheet = async (): Promise<string | null> => {
    try {
      const url = await fetchLetterCoverSheetBlobUrl(id);
      // STOR-3 sibling fix: this never revoked the previous cover sheet blob
      // on a second load — the same leak shape loadPdf already guarded
      // against with its own `if (old) URL.revokeObjectURL(old)`.
      if (coverSheetUrlRef.current) URL.revokeObjectURL(coverSheetUrlRef.current);
      coverSheetUrlRef.current = url;
      setCoverSheetUrl(url);
      return url;
    } catch (e) {
      toast.error(letterErrorMessage(e, 'Cover sheet failed'));
      return null;
    }
  };

  const downloadCoverSheet = async () => {
    const url = coverSheetUrl ?? await loadCoverSheet();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(letter?.referenceNumber ?? 'letter').replace(/\//g, '-')}-cover-sheet.pdf`;
    a.click();
  };

  // Physical-mail path: print the QR cover sheet for a recipient who has no
  // email, or won't accept a digital letter — same pattern as printPdf().
  const printCoverSheet = async () => {
    const url = coverSheetUrl ?? await loadCoverSheet();
    if (!url) return;
    const w = window.open(url, '_blank');
    w?.addEventListener('load', () => w.print(), { once: true });
  };

  if (isLoading) {
    return <div className="flex flex-1 items-center justify-center py-20"><span className="h-8 w-8 rounded-full border-4 border-t-transparent animate-spin" style={{ borderColor: 'var(--brand-500)' }} /></div>;
  }

  if (isError || !letter) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto ui-scrollbar">
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
          <Link href="/dashboard/letters" className="inline-flex items-center gap-1.5 text-[13px] mb-4" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back to correspondence
          </Link>
          <div className="ui-card text-center py-12">
            <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Letter not found</p>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>It may have been deleted, archived outside your access scope, or the link is incorrect.</p>
          </div>
        </div>
      </div>
    );
  }

  const myRoles = roles?.length ? roles : role ? [role] : [];
  const pendingStep = (letter.approvalSteps ?? []).find((s) => s.status === 'PENDING');
  const escalatedToMe = Boolean(pendingStep && userId && (pendingStep.escalatedToUserIds ?? []).includes(userId));
  const canDecide = pendingStep && (pendingStep.assignedUserId === userId || (pendingStep.assignedRole && myRoles.includes(pendingStep.assignedRole)) || escalatedToMe) &&
    (pendingStep.stepType === 'APPROVE' ? can(PERMISSIONS.LETTER_APPROVE) : can(PERMISSIONS.LETTER_REVIEW) || can(PERMISSIONS.LETTER_APPROVE));
  const isDraftEditable = ['DRAFT', 'RETURNED'].includes(letter.status) && letter.createdBy === userId;
  // Admin recovery (mirrors reassignStep's server-side gate): reassign a
  // stuck PENDING step when the assignee left or the role is unstaffed.
  const canReassign = letter.status === 'IN_REVIEW' && (can(PERMISSIONS.DEPT_MANAGE) || can(PERMISSIONS.ACL_BYPASS_ADMIN));
  // Delegation (2026-10-10): the person a step is waiting on may hand it to one named colleague, with a reason, without a department head.
  const canDelegate = letter.status === 'IN_REVIEW' && !canReassign && Boolean(pendingStep) && pendingStep!.assignedUserId === userId;
  // A signature ceremony can stall the same way a review step can (signer
  // deactivated, request expired) — same admin recovery path, extended to
  // PENDING_SIGNATURE (see LetterStateMachine.ts's PENDING_SIGNATURE ->
  // CANCELLED transition).
  const canRecall = letter.status === 'IN_REVIEW' && letter.createdBy === userId;
  const recallNeedsReason = (letter.approvalSteps ?? []).some((s) => s.status === 'APPROVED' || s.status === 'RETURNED');
  const canAdminCancel = ['IN_REVIEW', 'PENDING_SIGNATURE'].includes(letter.status) && (can(PERMISSIONS.DEPT_MANAGE) || can(PERMISSIONS.ACL_BYPASS_ADMIN));
  // Approved but never signed: the drafter (or a department head) can withdraw it with a reason; a signed,
  // numbered letter cannot be cancelled (backend ERR-LETTER-NOT-CANCELLABLE).
  const canWithdrawApproved =
    letter.status === 'APPROVED' && !letter.referenceNumber &&
    (letter.createdBy === userId || can(PERMISSIONS.DEPT_MANAGE) || can(PERMISSIONS.ACL_BYPASS_ADMIN));
  // Separation of duties: the drafter cannot approve their own letter (backend ERR-SELF-APPROVAL); they can still return it.
  const isOwnLetter = letter.createdBy === userId;

  // An outgoing composed letter that has cleared approval but has NOT been
  // signed yet: status APPROVED with no filed document. Signing is now a
  // separate, explicit action, so this is a real waiting state rather than a
  // transient one — and it is deliberately NOT a letter of record yet, because
  // the reference number and the final PDF are both produced at signature.
  const awaitingSigningInitiation =
    letter.status === 'APPROVED' &&
    !letter.documentId &&
    letter.direction === 'OUTGOING' &&
    letter.originType === 'COMPOSED';

  // Mirrors the backend's own documentId ?? attachmentDocumentId fallback
  // (letters.service.ts's downloadLetterPdf) — see the FIX comment on the
  // button row below for why this can't just be `letter.documentId`.
  const hasContent = Boolean(letter.documentId ?? letter.attachmentDocumentId);
  const previewIsStagedOnly = !letter.documentId && Boolean(letter.attachmentDocumentId);

  const links = [...(linksData?.data.outbound ?? []), ...(linksData?.data.inbound ?? [])];
  const assignee = letter.assignee ? `${letter.assignee.firstName} ${letter.assignee.lastName}` : letter.assignedToUserId ?? '--';
  const overdue = Boolean(letter.dueDate && !['RESPONDED', 'CLOSED', 'ARCHIVED'].includes(letter.status) && new Date(letter.dueDate) < new Date());

  return (
    <div className="flex-1 min-h-0 overflow-y-auto ui-scrollbar">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Link href="/dashboard/letters" className="inline-flex items-center gap-1.5 text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to correspondence
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageHeader title={letter.subject} subtitle={letter.referenceNumber ?? 'Draft - reference number assigned at approval'} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={overdue ? 'OVERDUE' : letter.status} />
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {letter.direction === 'OUTGOING' ? 'Outgoing' : 'Incoming'} - {letter.letterType} - {letter.confidentiality} - {letter.priority}
                {letter.originType === 'SCANNED' && ' - Scanned/uploaded'}
                {letter.originType === 'COMPOSED' && ' - Composed'}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* FIX 2026-09-15: a SCANNED letter's uploaded file is staged
                into attachmentDocumentId immediately and only promoted to
                documentId at final approval — gating every button here on
                documentId alone meant a reviewer/approver deciding a SCANNED
                letter in DRAFT/IN_REVIEW had no way to see what they were
                deciding on. hasContent mirrors the backend's own
                documentId ?? attachmentDocumentId fallback (letters.service.ts's
                downloadLetterPdf), so "is there something to look at" agrees
                on both sides. */}
            {hasContent && (
              <button onClick={downloadPdf} className="ui-btn ui-btn-secondary">
                <Download className="h-4 w-4" /> {letter.originType === 'SCANNED' ? (letter.documentId ? 'Original' : 'Uploaded file (unapproved)') : 'PDF'}
              </button>
            )}
            {hasContent && <button onClick={printPdf} className="ui-btn ui-btn-secondary"><Printer className="h-4 w-4" /> Print</button>}
            {hasContent && !pdfUrl && <button onClick={loadPdf} className="ui-btn ui-btn-secondary"><ExternalLink className="h-4 w-4" /> Preview</button>}
            {letter.coverSheetDocumentId && (
              <button onClick={downloadCoverSheet} className="ui-btn ui-btn-secondary">
                <QrCode className="h-4 w-4" /> Cover sheet
              </button>
            )}
            {letter.coverSheetDocumentId && (
              <button onClick={printCoverSheet} className="ui-btn ui-btn-secondary" title="For mailing on paper — carries the verification QR">
                <Printer className="h-4 w-4" /> Print cover sheet
              </button>
            )}
            {letter.direction === 'INCOMING' && can(PERMISSIONS.LETTER_REGISTER) && (
              <button onClick={() => { setAssignForm({ assignedToUserId: letter.assignedToUserId ?? '', dueDate: letter.dueDate?.slice(0, 10) ?? '' }); setAssignOpen(true); }} className="ui-btn ui-btn-secondary">
                <UserPlus className="h-4 w-4" /> Assign
              </button>
            )}
            {letter.direction === 'INCOMING' && ['RECEIVED'].includes(letter.status) && can(PERMISSIONS.LETTER_REGISTER) && (
              <button onClick={() => resolveMut.mutate('RESPONDED')} className="ui-btn ui-btn-primary"><CheckCircle2 className="h-4 w-4" /> Responded</button>
            )}
            {letter.direction === 'INCOMING' && ['RECEIVED', 'RESPONDED'].includes(letter.status) && can(PERMISSIONS.LETTER_REGISTER) && (
              <button onClick={() => resolveMut.mutate('CLOSED')} className="ui-btn ui-btn-secondary">Close</button>
            )}
            {isDraftEditable && (
              <>
                <button onClick={() => { setEditForm({ subject: letter.subject, bodyHtml: letter.bodyHtml ?? '' }); setEditing(true); }} className="ui-btn ui-btn-secondary">Edit draft</button>
                <button onClick={() => setSubmitOpen(true)} disabled={submitMut.isPending} className="ui-btn ui-btn-primary"><Send className="h-4 w-4" /> Submit</button>
                <button onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending} className="ui-btn ui-btn-danger"><XCircle className="h-4 w-4" /> Cancel</button>
              </>
            )}
            {canRecall && (
              <button
                onClick={() => setRecallOpen(true)}
                className="ui-btn ui-btn-secondary"
                title="Pull this letter back out of review so you can edit it, then submit it again"
              >
                <Undo2 className="h-4 w-4" /> Recall to edit
              </button>
            )}
            {canWithdrawApproved && (
              <button
                onClick={() => setAdminCancelOpen(true)}
                className="ui-btn ui-btn-danger"
                title="Withdraw this approved letter before it is signed (reason required)"
              >
                <XCircle className="h-4 w-4" /> Withdraw letter
              </button>
            )}
            {canAdminCancel && (
              <button
                onClick={() => setAdminCancelOpen(true)}
                className="ui-btn ui-btn-danger"
                title="Admin override: cancel a deadlocked in-review or awaiting-signature letter (reason required)"
              >
                <XCircle className="h-4 w-4" /> Cancel (admin)
              </button>
            )}
            {awaitingSigningInitiation && (can(PERMISSIONS.LETTER_APPROVE) || letter.createdBy === userId) && (
              <button
                onClick={() => setSignOpen(true)}
                disabled={initiateSignMut.isPending}
                className="ui-btn ui-btn-primary"
                title="Approval is complete — choose who signs this letter"
              >
                <PenLine className="h-4 w-4" /> Initiate signing
              </button>
            )}
            {['APPROVED', 'DISPATCHED'].includes(letter.status) && !awaitingSigningInitiation && letter.direction === 'OUTGOING' && can(PERMISSIONS.LETTER_DISPATCH) && (
              <button
                onClick={() => {
                  setDispatchForm((f) => ({ ...f, recipientName: letter.correspondent ?? '', recipientAddress: letter.correspondentEmail ?? '' }));
                  setDispatchOpen(true);
                }}
                className="ui-btn ui-btn-primary"
              >
                <Truck className="h-4 w-4" /> Dispatch
              </button>
            )}
            {['APPROVED', 'DISPATCHED', 'RECEIVED', 'RESPONDED', 'CLOSED'].includes(letter.status) && !awaitingSigningInitiation && can(PERMISSIONS.LETTER_DISPATCH) && (
              <button onClick={() => archiveMut.mutate()} disabled={archiveMut.isPending} className="ui-btn ui-btn-secondary"><Archive className="h-4 w-4" /> Archive</button>
            )}
          </div>
        </div>

        {awaitingSigningInitiation && (
          <div
            className="ui-card mt-4 flex flex-wrap items-center justify-between gap-3"
            style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.25)' }}
          >
            <div className="flex items-center gap-2.5">
              <PenLine className="h-4 w-4 shrink-0" style={{ color: '#7c3aed' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Approved. Choose who signs it — the reference number is allocated when it is signed,
                so it cannot be dispatched until then.
              </p>
            </div>
          </div>
        )}

        {letter.status === 'PENDING_SIGNATURE' && (
          <div
            className="ui-card mt-4 flex flex-wrap items-center justify-between gap-3"
            style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.25)' }}
          >
            <div className="flex items-center gap-2.5">
              <PenLine className="h-4 w-4 shrink-0" style={{ color: '#7c3aed' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                Approved — awaiting {letter.signatoryName ?? 'the approver'}&apos;s signature before a reference
                number is allocated and the letter can be dispatched.
              </p>
            </div>
            {letter.signatory?.id === userId && (
              <Link href="/dashboard/signing/pending" className="ui-btn ui-btn-secondary shrink-0">
                <PenLine className="h-4 w-4" /> Go sign it
              </Link>
            )}
          </div>
        )}

        {previewIsStagedOnly && (
          <div
            className="ui-card mt-4 flex flex-wrap items-center justify-between gap-3"
            style={{ background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.25)' }}
          >
            <div className="flex items-center gap-2.5">
              <ExternalLink className="h-4 w-4 shrink-0" style={{ color: '#2563eb' }} />
              <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                This is the uploaded original, staged for review — it has not been approved yet, so it carries no
                reference number or verification QR. Use Preview below to see exactly what you would be
                approving/signing.
              </p>
            </div>
          </div>
        )}

        <div className="ui-card mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Meta label="Unit" value={letter.orgUnit ? `${letter.orgUnit.code} - ${letter.orgUnit.name}` : '--'} />
          <Meta label="Department" value={letter.department?.name ?? '--'} />
          <Meta label={letter.direction === 'OUTGOING' ? 'Recipient' : 'Sender'} value={letter.correspondent ?? '--'} />
          <Meta label="Organization" value={letter.correspondentOrganization ?? '--'} />
          <Meta label="Location" value={letter.correspondentLocation ?? '--'} />
          <Meta label="Email" value={letter.correspondentEmail ?? '--'} />
          <Meta label="Drafted by" value={letter.creator ? `${letter.creator.firstName} ${letter.creator.lastName}` : '--'} />
          <Meta label="Approved / received" value={safeDate(letter.approvedAt ?? letter.receivedDate)} />
          <Meta label="Assignee" value={assignee} />
          <Meta label="Due date" value={letter.dueDate ? safeDate(letter.dueDate, 'dd MMM yyyy') : '--'} />
        </div>

        {pdfUrl && (
          <div className="ui-card mt-4 p-0 overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
              <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>PDF preview</p>
              <button
                onClick={() => {
                  // STOR-3 sibling fix: this used to null the state without
                  // ever revoking the blob — since loadPdf's own revoke-old
                  // check only fires when it finds a NON-null `old` value,
                  // hiding then re-opening the preview permanently leaked
                  // the original blob every time.
                  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
                  pdfUrlRef.current = null;
                  setPdfUrl(null);
                }}
                className="text-[12px]"
                style={{ color: 'var(--text-muted)' }}
              >
                Hide
              </button>
            </div>
            <div className="max-h-[720px] overflow-y-auto p-2">
              <PdfBlobPreview blobUrl={pdfUrl} />
            </div>
          </div>
        )}

        {letter.qrPayload && (
          <div className="ui-card mt-4 flex items-center gap-3">
            <QrCode className="h-5 w-5 shrink-0" style={{ color: 'var(--brand-600)' }} />
            <a href={letter.qrPayload} target="_blank" rel="noreferrer" className="text-[12px] underline break-all" style={{ color: 'var(--brand-600)' }}>{letter.qrPayload}</a>
          </div>
        )}

        {letter.bodyHtml && (
          <div className="ui-card mt-4">
            <p className="text-[12px] font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Letter body</p>
            <LetterBodyView content={letter.bodyHtml} className="text-[14px] leading-relaxed" />
          </div>
        )}

        {((letter.attachments ?? []).length > 0 || isDraftEditable) && (
          <div className="ui-card mt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Attachments {(letter.attachments ?? []).length > 0 && `(${letter.attachments!.length})`}
              </p>
              {isDraftEditable && (
                <label className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px] cursor-pointer inline-flex">
                  <Paperclip className="h-3.5 w-3.5" /> Attach file
                  <input
                    type="file"
                    accept="application/pdf,image/*,.doc,.docx"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) addAttachmentMut.mutate(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
            {(letter.attachments ?? []).length === 0 ? (
              <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>No attachments.</p>
            ) : (
              <ul className="space-y-1.5">
                {letter.attachments!.map((a) => {
                  const previewable = isPreviewableAttachment(a.originalFilename);
                  return (
                    <li key={a.id} className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px]" style={{ background: 'var(--surface-raised)' }}>
                      <Paperclip className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                      {previewable ? (
                        <button onClick={() => previewAttachment(a.id, a.originalFilename)} className="truncate flex-1 text-left underline" style={{ color: 'var(--brand-600)' }} title={a.originalFilename}>
                          {a.originalFilename}
                        </button>
                      ) : (
                        <span className="truncate flex-1" title={`${a.originalFilename} (no in-browser preview for this file type)`}>{a.originalFilename}</span>
                      )}
                      <span style={{ color: 'var(--text-muted)' }}>{safeDate(a.createdAt, 'dd MMM yyyy')}</span>
                      {previewable && (
                        <button onClick={() => previewAttachment(a.id, a.originalFilename)} className="p-1 rounded hover:bg-black/5" title={attachmentPreview?.id === a.id ? 'Hide preview' : 'Preview'}>
                          <Eye className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        </button>
                      )}
                      <button onClick={() => downloadAttachment(a.id, a.originalFilename)} className="p-1 rounded hover:bg-black/5" title="Download">
                        <Download className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                      </button>
                      {isDraftEditable && (
                        <button onClick={() => removeAttachmentMut.mutate(a.id)} className="p-1 rounded hover:bg-red-50" title="Remove">
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {attachmentPreview && (
              <div className="ui-card mt-3 p-0 overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
                  <p className="text-[12px] font-bold uppercase tracking-wide truncate" style={{ color: 'var(--text-muted)' }}>
                    Preview — {attachmentPreview.filename}
                  </p>
                  <button
                    onClick={() => { URL.revokeObjectURL(attachmentPreview.url); attachmentPreviewRef.current = null; setAttachmentPreview(null); }}
                    className="text-[12px] shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Hide
                  </button>
                </div>
                <div className="max-h-[720px] overflow-y-auto p-2">
                  {/\.pdf$/i.test(attachmentPreview.filename) ? (
                    <PdfBlobPreview blobUrl={attachmentPreview.url} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- blob: URL, next/image can't fetch it
                    <img src={attachmentPreview.url} alt={attachmentPreview.filename} className="max-w-full mx-auto" />
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {(letter.approvalSteps ?? []).length > 0 && (
          <div className="ui-card mt-4">
            <p className="text-[12px] font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>Approval chain</p>
            <ul className="space-y-2">
              {(letter.approvalSteps ?? []).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                  <span className="text-[12px] font-mono w-6" style={{ color: 'var(--text-muted)' }}>#{s.stepOrder}</span>
                  <span className="text-[13px] font-medium">{s.stepType === 'APPROVE' ? 'Approve and sign' : 'Review'}</span>
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>to {s.assignedUser ? `${s.assignedUser.firstName} ${s.assignedUser.lastName} (${s.assignedUser.email})` : s.assignedRole ? s.assignedRole.replace(/_/g, ' ') : 'named user'}</span>
                  <StatusBadge status={s.status} />
                  {s.status === 'PENDING' && s.dueAt && <DueBadge dueAt={s.dueAt} breached={Boolean(s.slaBreachedAt)} />}
                  {s.status === 'PENDING' && s.escalatedAt && (
                    <span className="text-[11px] font-semibold rounded px-1.5 py-0.5" style={{ background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning, #92400e)' }}
                      title="The department head can decide this step beside the person it was assigned to">
                      Escalated{escalatedToMe ? ' to you' : ''}
                    </span>
                  )}
                  {/* Distinct from "to" above: that's who a role-assigned step is
                      OWED to (any DEPT_MANAGER); this is the specific person who
                      actually decided it, which is the same name only by
                      coincidence when that person also holds the assigned role. */}
                  {s.decidedByUser && (
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      — decided by {s.decidedByUser.firstName} {s.decidedByUser.lastName} ({s.decidedByUser.email})
                    </span>
                  )}
                  {s.comment && <span className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>{s.comment}</span>}
                  {s.decidedAt && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{safeDate(s.decidedAt)}</span>}
                  {s.status === 'PENDING' && (canDecide || canReassign || (canDelegate && s.id === pendingStep?.id)) && (
                    <span className="ml-auto flex gap-2">
                      {canDecide && (
                        <>
                          {isOwnLetter ? (
                            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }} title="You drafted this letter. Return it, or ask a department head to assign another approver.">
                              You drafted this letter, so you cannot approve it
                            </span>
                          ) : (
                            <button onClick={() => setDecisionModal({ step: s, decision: 'APPROVE' })} className="ui-btn ui-btn-primary !py-1 !px-2.5 text-[12px]"><CheckCircle2 className="h-3.5 w-3.5" /> Approve</button>
                          )}
                          <button onClick={() => setDecisionModal({ step: s, decision: 'RETURN' })} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"><Undo2 className="h-3.5 w-3.5" /> Return</button>
                        </>
                      )}
                      {canDelegate && s.id === pendingStep?.id && (
                        <button
                          onClick={() => { setReassignForm({ assignedUserId: '', assignedRole: '', reason: '' }); setReassignStepTarget(s); }}
                          className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"
                          title="Hand this step to a colleague (you are away or cannot take it) — a reason is recorded"
                        >
                          <UserPlus className="h-3.5 w-3.5" /> Delegate
                        </button>
                      )}
                      {canReassign && (
                        <button
                          onClick={() => { setReassignForm({ assignedUserId: '', assignedRole: '', reason: '' }); setReassignStepTarget(s); }}
                          className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"
                          title="Admin recovery — move this pending step to another user or role"
                        >
                          <UserPlus className="h-3.5 w-3.5" /> Reassign
                        </button>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(letter.revisions ?? []).length > 0 && (
          <div className="ui-card mt-4">
            <p className="text-[12px] font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>Revision history</p>
            <ul className="space-y-1.5">
              {(letter.revisions ?? []).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                  <History className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <span className="font-mono text-[12px]" style={{ color: 'var(--text-muted)' }}>rev {r.revisionNo}</span>
                  <span className="font-medium truncate max-w-[50%]" title={r.subject}>{r.subject}</span>
                  {r.author && (
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>by {r.author.firstName} {r.author.lastName}</span>
                  )}
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{safeDate(r.createdAt)}</span>
                  <button onClick={() => setViewRevisionNo(r.revisionNo)} className="ml-auto ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]">View body</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(letter.dispatches ?? []).length > 0 && (
          <div className="ui-card mt-4">
            <p className="text-[12px] font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>Dispatch and delivery</p>
            <ul className="space-y-2">
              {(letter.dispatches ?? []).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                  <Truck className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
                  <span className="font-medium">{d.channel.replace(/_/g, ' ')}</span>
                  {d.recipientName && <span style={{ color: 'var(--text-muted)' }}>to {d.recipientName}</span>}
                  {d.dispatcher && <span style={{ color: 'var(--text-muted)' }}>by {d.dispatcher.firstName} {d.dispatcher.lastName}</span>}
                  <span style={{ color: 'var(--text-muted)' }}>{safeDate(d.dispatchedAt)}</span>
                  {d.trackingReference && <span className="font-mono text-[12px]">{d.trackingReference}</span>}
                  {d.acknowledgedAt ? <span className="text-emerald-600 text-[12px]">acknowledged {safeDate(d.acknowledgedAt)}</span> : can(PERMISSIONS.LETTER_DISPATCH) && <button onClick={() => acknowledgeMut.mutate(d.id)} className="ui-btn ui-btn-secondary !py-1 !px-2 text-[12px]">Acknowledge</button>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ui-card mt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Related correspondence</p>
            <button onClick={() => setLinkOpen(true)} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]"><Link2 className="h-3.5 w-3.5" /> Link letter</button>
          </div>
          {links.length === 0 ? <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>No linked letters.</p> : (
            <ul className="space-y-1.5">
              {links.map((l) => {
                const other = l.relatedLetter ?? l.letter;
                if (!other) return null;
                return (
                  <li key={l.id} className="flex items-center gap-2 text-[13px]">
                    <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)' }}>{l.linkType.replace(/_/g, ' ')}</span>
                    <button onClick={() => other.id && router.push(`/dashboard/letters/${other.id}`)} className="underline" style={{ color: 'var(--brand-600)' }}>{other.referenceNumber ?? other.subject}</button>
                    <span style={{ color: 'var(--text-muted)' }}>{other.subject}</span>
                    <button onClick={() => unlinkMut.mutate(l.id)} className="ml-auto p-1 rounded hover:bg-red-50" title="Unlink"><Trash2 className="h-3.5 w-3.5 text-red-500" /></button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <Modal isOpen={Boolean(decisionModal)} onClose={() => setDecisionModal(null)} title={decisionModal?.decision === 'APPROVE' ? 'Approve letter' : 'Return for correction'}>
        <div className="space-y-3">
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={decisionModal?.decision === 'RETURN' ? 'Reason for returning (required)' : 'Comment'} className="ui-input w-full min-h-[90px]" />
          <div className="flex justify-end gap-2"><button onClick={() => setDecisionModal(null)} className="ui-btn ui-btn-secondary">Cancel</button><button onClick={() => decisionModal && decideMut.mutate({ stepId: decisionModal.step.id, decision: decisionModal.decision, c: comment || undefined })} disabled={decideMut.isPending || (decisionModal?.decision === 'RETURN' && !comment.trim())} className={decisionModal?.decision === 'APPROVE' ? 'ui-btn ui-btn-primary' : 'ui-btn ui-btn-danger'}>{decideMut.isPending ? 'Working...' : decisionModal?.decision === 'APPROVE' ? 'Approve' : 'Return'}</button></div>
        </div>
      </Modal>

      <Modal isOpen={Boolean(reassignStepTarget)} onClose={() => setReassignStepTarget(null)} title={canDelegate ? 'Delegate your step' : 'Reassign pending step'}>
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Admin recovery: move step #{reassignStepTarget?.stepOrder} to a different user or role
            (e.g. the assignee left, or the role is unstaffed). Pick a user OR a role.
          </p>
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Assign to user</span>
            <select
              value={reassignForm.assignedUserId}
              onChange={(e) => setReassignForm((f) => ({ ...f, assignedUserId: e.target.value, assignedRole: '' }))}
              className="ui-input mt-1 w-full"
            >
              <option value="">— pick a user —</option>
              {(canDelegate ? (delegateAssignees?.data ?? []) : (usersData?.data ?? [])).map((u: { id: string; firstName: string; lastName: string; email: string }) => (
                <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
              ))}
            </select>
          </label>
          {!canDelegate && (
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Or assign to role</span>
            <select
              value={reassignForm.assignedRole}
              onChange={(e) => setReassignForm((f) => ({ ...f, assignedRole: e.target.value, assignedUserId: '' }))}
              className="ui-input mt-1 w-full"
            >
              <option value="">— pick a role —</option>
              {/* Scoped to the stuck step's own type — reassignStep runs the
                  same assertStepIsActionable check submit does, so offering an
                  Approve-only role for a Review step (or vice versa) would
                  only produce ERR-STEP-ROLE-INVALID. */}
              {(reassignStepTarget ? rolesByStepType[reassignStepTarget.stepType] : ROLES).map((r) => {
                const none = reassignStepTarget ? unstaffedByStepType[reassignStepTarget.stepType].has(r) : false;
                return (
                  <option key={r} value={r}>
                    {r.replace(/_/g, ' ')}{none ? ` — nobody in ${deptLabel}` : ''}
                  </option>
                );
              })}
            </select>
          </label>
          )}
          <textarea
            value={reassignForm.reason}
            onChange={(e) => setReassignForm((f) => ({ ...f, reason: e.target.value }))}
            placeholder="Reason (recorded in the audit log)"
            className="ui-input w-full min-h-[70px]"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setReassignStepTarget(null)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => reassignMut.mutate()}
              disabled={reassignMut.isPending || (!reassignForm.assignedUserId && !reassignForm.assignedRole) || reassignRoleUnstaffed || (canDelegate && !reassignForm.reason.trim())}
              className="ui-btn ui-btn-primary"
            >
              {reassignMut.isPending ? 'Working…' : 'Reassign step'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={recallOpen} onClose={() => setRecallOpen(false)} title="Recall letter to edit">
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">
            The letter goes back to you as <strong>Returned</strong>. Steps nobody has decided yet are cancelled; steps that were
            already decided stay in the history. Edit it, then submit it for approval again with a new chain.
          </p>
          <textarea
            className="ui-input w-full"
            rows={3}
            placeholder={recallNeedsReason ? 'Reason (required, at least 10 characters) — the reviewers who already acted are told' : 'Reason (optional)'}
            value={recallReason}
            onChange={(e) => setRecallReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRecallOpen(false)} className="ui-btn ui-btn-secondary">Back</button>
            <button
              onClick={() => recallMut.mutate()}
              disabled={recallMut.isPending || (recallNeedsReason && recallReason.trim().length < 10)}
              className="ui-btn ui-btn-primary"
            >
              {recallMut.isPending ? 'Working…' : 'Recall letter'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={adminCancelOpen} onClose={() => setAdminCancelOpen(false)} title={letter.status === 'APPROVED' ? 'Withdraw approved letter' : 'Cancel in-review letter (admin override)'}>
        <div className="space-y-3">
          {letter.status === 'APPROVED' && (
            <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              This letter finished approval but was never signed. Withdrawing it cancels the letter and discards the
              approval; it is kept in the register as cancelled. A reason of at least 10 characters is recorded in the audit log.
            </p>
          )}
          <p className="text-[12px]" style={{ color: 'var(--text-muted)', display: letter.status === 'APPROVED' ? 'none' : undefined }}>
            This letter is already in review — cancelling it now is an admin override for a deadlocked chain
            (e.g. every remaining approver is unreachable). Every pending/waiting step is cancelled along with it.
            A reason of at least 10 characters is required and is recorded in the audit log.
          </p>
          <textarea
            value={adminCancelReason}
            onChange={(e) => setAdminCancelReason(e.target.value)}
            placeholder="Reason (min 10 characters)"
            className="ui-input w-full min-h-[80px]"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdminCancelOpen(false)} className="ui-btn ui-btn-secondary">Back</button>
            <button
              onClick={() => adminCancelMut.mutate()}
              disabled={adminCancelMut.isPending || adminCancelReason.trim().length < 10}
              className="ui-btn ui-btn-danger"
            >
              {adminCancelMut.isPending ? 'Working…' : 'Cancel letter'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={submitOpen} onClose={() => setSubmitOpen(false)} title="Submit approval chain" size="lg">
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Each step goes either to a <strong>role queue</strong> (anyone holding that role
            <em> in this letter&apos;s department</em>) or to a <strong>named person</strong> (anyone in the
            organisation — no department restriction).
          </p>
          {chainSteps.map((step, idx) => {
            const candidates = assigneesByStepType[step.stepType];
            const picked = candidates.find((u) => u.id === step.assignedUserId);
            const roleOptions = rolesByStepType[step.stepType];
            return (
              <div key={idx} className="grid grid-cols-1 gap-2 rounded-lg border p-3 md:grid-cols-4" style={{ borderColor: 'var(--border)' }}>
                {/* Review and Approver are gone — every step is an Approve
                    step, and the only role actually staffed for it here is
                    Dept Manager. Kept as a plain label rather than a
                    single-option dropdown. */}
                <div className="ui-input w-full flex items-center" style={{ color: 'var(--text-secondary)' }}>Approve</div>
                <select value={step.assignedRole} onChange={(e) => setChainSteps((steps) => steps.map((s, i) => i === idx ? { ...s, assignedRole: e.target.value, assignedUserId: '' } : s))} disabled={Boolean(step.assignedUserId)} className="ui-input w-full">
                  {(roleOptions.includes(step.assignedRole) ? roleOptions : [step.assignedRole, ...roleOptions]).map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, ' ')}{unstaffedByStepType[step.stepType].has(r) ? ` — nobody in ${deptLabel}` : ''}
                    </option>
                  ))}
                </select>
                <select value={step.assignedUserId} onChange={(e) => setChainSteps((steps) => steps.map((s, i) => i === idx ? { ...s, assignedUserId: e.target.value } : s))} className="ui-input w-full">
                  <option value="">Role queue</option>
                  {candidates.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>)}
                </select>
                <button onClick={() => setChainSteps((steps) => steps.filter((_, i) => i !== idx))} disabled={chainSteps.length <= 1} className="ui-btn ui-btn-secondary">Remove</button>
                <label className="md:col-span-4 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  Deadline for this step
                  <select
                    value={step.slaHours}
                    onChange={(e) => setChainSteps((steps) => steps.map((s, i) => i === idx ? { ...s, slaHours: e.target.value ? Number(e.target.value) : '' } : s))}
                    className="ui-input"
                    aria-label={`Deadline for step ${idx + 1}`}
                  >
                    <option value="">No deadline (organisation default)</option>
                    <option value="4">4 hours</option>
                    <option value="24">1 day</option>
                    <option value="48">2 days</option>
                    <option value="72">3 days</option>
                    <option value="168">1 week</option>
                    <option value="336">2 weeks</option>
                  </select>
                  <span style={{ color: 'var(--text-muted)' }}>Counted from when the step reaches this person. If it is missed, they and you are told, and after a grace period the department head can decide it too.</span>
                </label>
                {!step.assignedUserId && unstaffedByStepType[step.stepType].has(step.assignedRole) && (
                  <p className="md:col-span-4 text-[12px]" style={{ color: 'var(--danger)' }}>
                    Nobody in {deptLabel} holds {step.assignedRole.replace(/_/g, ' ')}, so this role queue
                    would have no one to act on it. Pick a named person for this step, choose another role,
                    or have someone in {deptLabel} granted that role.
                  </p>
                )}
                {step.assignedUserId && (
                  <div className="md:col-span-4">
                    <AssignmentAdvisoryNotice
                      candidateUserId={step.assignedUserId}
                      candidateDepartments={picked?.departments}
                      candidateLabel={picked ? `${picked.firstName} ${picked.lastName}` : undefined}
                      departmentId={letter.department?.id}
                      resourceType="department"
                      resourceId={letter.department?.id}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={() => setChainSteps((steps) => [...steps, { stepType: 'APPROVE', assignedRole: 'DEPT_MANAGER', assignedUserId: '', slaHours: '' }])} className="ui-btn ui-btn-secondary">Add step</button>
          {blockedSteps.length > 0 && (
            <p className="text-[12px] font-medium" style={{ color: 'var(--danger)' }}>
              {blockedSteps.length === 1 ? 'Step' : 'Steps'} {blockedSteps.map(({ i }) => i + 1).join(', ')}{' '}
              {blockedSteps.length === 1 ? 'is' : 'are'} assigned to a role with nobody in {deptLabel}.
              Submitting would be refused.
            </p>
          )}

          <div className="flex justify-end gap-2"><button onClick={() => setSubmitOpen(false)} className="ui-btn ui-btn-secondary">Cancel</button><button onClick={() => submitMut.mutate()} disabled={submitMut.isPending || chainSteps.length === 0 || blockedSteps.length > 0} className="ui-btn ui-btn-primary">Submit for approval</button></div>
        </div>
      </Modal>
      <Modal isOpen={signOpen} onClose={() => setSignOpen(false)} title="Initiate signing">
        <div className="space-y-3">
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Approval is complete. Choose who signs this letter — they receive a signature request,
            not an approval task. The reference number and the final PDF are produced once it is signed.
          </p>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="flex flex-col gap-1.5 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="radio" name="sign-mode" checked={signatoryMode === 'user'} onChange={() => setSignatoryMode('user')} />
                <span>A specific person signs <span style={{ color: 'var(--text-muted)' }}>(any active member of this tenant)</span></span>
              </label>
              {signatoryMode === 'user' && (
                <div className="pl-6">
                  <select value={signatoryUserId} onChange={(e) => setSignatoryUserId(e.target.value)} className="ui-input w-full">
                    <option value="">— pick a person —</option>
                    {(signatoryAssignees?.data ?? []).map((u) => (
                      <option key={u.id} value={u.id}>{u.firstName} {u.lastName} ({u.email})</option>
                    ))}
                  </select>
                  {signatoryUserId && (() => {
                    const picked = (signatoryAssignees?.data ?? []).find((u) => u.id === signatoryUserId);
                    return (
                      <AssignmentAdvisoryNotice
                        className="mt-1"
                        candidateUserId={signatoryUserId}
                        candidateDepartments={picked?.departments}
                        candidateLabel={picked ? `${picked.firstName} ${picked.lastName}` : undefined}
                        departmentId={letter.department?.id}
                        resourceType="department"
                        resourceId={letter.department?.id}
                      />
                    );
                  })()}
                </div>
              )}

              <label className="flex items-center gap-2">
                <input type="radio" name="sign-mode" checked={signatoryMode === 'role'} onChange={() => setSignatoryMode('role')} />
                <span>Anyone holding a role signs <span style={{ color: 'var(--text-muted)' }}>(department-scoped)</span></span>
              </label>
              {signatoryMode === 'role' && (
                <div className="pl-6">
                  <select value={signatoryRole} onChange={(e) => setSignatoryRole(e.target.value)} className="ui-input w-full">
                    {signatoryRoles.map((r) => (
                      <option key={r} value={r}>
                        {r.replace(/_/g, ' ')}{signatoryUnstaffed.has(r) ? ` — nobody in ${deptLabel}` : ''}
                      </option>
                    ))}
                  </select>
                  {signatoryUnstaffed.has(signatoryRole) ? (
                    <p className="mt-1 text-[11px] font-medium" style={{ color: 'var(--danger)' }}>
                      Nobody in {deptLabel} holds {signatoryRole.replace(/_/g, ' ')}, so there would be no one
                      to sign. Name a person instead, or choose a role someone here holds.
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Everyone holding this role in {deptLabel} is notified;
                      the first one to open it claims the signature.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => setSignOpen(false)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => initiateSignMut.mutate()}
              disabled={
                initiateSignMut.isPending ||
                (signatoryMode === 'user' && !signatoryUserId) ||
                (signatoryMode === 'role' && signatoryUnstaffed.has(signatoryRole))
              }
              className="ui-btn ui-btn-primary"
            >
              <PenLine className="h-4 w-4" /> Send for signature
            </button>
          </div>
        </div>
      </Modal>
      <Modal isOpen={assignOpen} onClose={() => setAssignOpen(false)} title="Route incoming letter">
        <div className="space-y-3">
          <select value={assignForm.assignedToUserId} onChange={(e) => setAssignForm((f) => ({ ...f, assignedToUserId: e.target.value }))} className="ui-input w-full">
            <option value="">Unassigned</option>
            {(usersData?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName} - {u.email}</option>)}
          </select>
          <input type="date" value={assignForm.dueDate} onChange={(e) => setAssignForm((f) => ({ ...f, dueDate: e.target.value }))} className="ui-input w-full" />
          <div className="flex justify-end gap-2"><button onClick={() => setAssignOpen(false)} className="ui-btn ui-btn-secondary">Cancel</button><button onClick={() => assignMut.mutate()} disabled={assignMut.isPending} className="ui-btn ui-btn-primary">Save routing</button></div>
        </div>
      </Modal>

      <Modal isOpen={dispatchOpen} onClose={() => setDispatchOpen(false)} title="Record dispatch">
        <div className="space-y-3">
          <select value={dispatchForm.channel} onChange={(e) => setDispatchForm((f) => ({ ...f, channel: e.target.value }))} className="ui-input w-full">{DISPATCH_CHANNELS.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select>
          <input value={dispatchForm.recipientName} onChange={(e) => setDispatchForm((f) => ({ ...f, recipientName: e.target.value }))} placeholder="Recipient name" className="ui-input w-full" />
          {dispatchForm.channel === 'EMAIL' ? (
            <div>
              <input type="email" value={dispatchForm.recipientAddress} onChange={(e) => setDispatchForm((f) => ({ ...f, recipientAddress: e.target.value }))} placeholder="Recipient email address" className="ui-input w-full" />
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {dispatchForm.recipientAddress
                  ? 'The letter (and QR cover sheet, if any) will be emailed here automatically once you record the dispatch.'
                  : 'No email on file — leave the channel as EMAIL only if you’ll add an address, otherwise switch to a paper channel and use the print buttons above.'}
              </p>
            </div>
          ) : (
            <div>
              <input value={dispatchForm.recipientAddress} onChange={(e) => setDispatchForm((f) => ({ ...f, recipientAddress: e.target.value }))} placeholder="Mailing address (optional)" className="ui-input w-full" />
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Physical delivery — use the Print / Print cover sheet buttons above to print the letter with its QR before mailing.
              </p>
            </div>
          )}
          <input value={dispatchForm.trackingReference} onChange={(e) => setDispatchForm((f) => ({ ...f, trackingReference: e.target.value }))} placeholder="Tracking reference" className="ui-input w-full" />
          <textarea value={dispatchForm.notes} onChange={(e) => setDispatchForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Notes" className="ui-input w-full min-h-[70px]" />
          <div className="flex justify-end gap-2"><button onClick={() => setDispatchOpen(false)} className="ui-btn ui-btn-secondary">Cancel</button><button onClick={() => dispatchMut.mutate()} disabled={dispatchMut.isPending} className="ui-btn ui-btn-primary">Record dispatch</button></div>
        </div>
      </Modal>

      <Modal isOpen={linkOpen} onClose={() => setLinkOpen(false)} title="Link related letter">
        <div className="space-y-3">
          <input value={linkSearch} onChange={(e) => setLinkSearch(e.target.value)} placeholder="Search by reference, subject, or correspondent" className="ui-input w-full" />
          {(linkCandidates?.data ?? []).length > 0 && <div className="max-h-48 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>{(linkCandidates?.data ?? []).filter((c) => c.id !== id).map((c) => <button key={c.id} onClick={() => setLinkForm((f) => ({ ...f, relatedLetterId: c.id }))} className="block w-full text-left px-3 py-2 text-[13px] hover:bg-surface-raised"><span className="font-mono text-[12px]">{c.referenceNumber ?? 'draft'}</span> - {c.subject}</button>)}</div>}
          <input value={linkForm.relatedLetterId} onChange={(e) => setLinkForm((f) => ({ ...f, relatedLetterId: e.target.value }))} placeholder="Related letter ID" className="ui-input w-full font-mono text-[12px]" />
          <select value={linkForm.linkType} onChange={(e) => setLinkForm((f) => ({ ...f, linkType: e.target.value as typeof linkForm.linkType }))} className="ui-input w-full"><option value="RELATED">Related</option><option value="REPLY_TO">Reply to</option><option value="FOLLOW_UP">Follow up</option></select>
          <div className="flex justify-end gap-2"><button onClick={() => setLinkOpen(false)} className="ui-btn ui-btn-secondary">Cancel</button><button onClick={() => linkMut.mutate()} disabled={linkMut.isPending || !linkForm.relatedLetterId} className="ui-btn ui-btn-primary">Link</button></div>
        </div>
      </Modal>

      <Modal isOpen={viewRevisionNo !== null} onClose={() => setViewRevisionNo(null)} title={`Revision ${viewRevisionNo ?? ''}`} size="2xl">
        {revisionLoading ? (
          <div className="flex items-center justify-center py-10">
            <span className="h-6 w-6 rounded-full border-4 border-t-transparent animate-spin" style={{ borderColor: 'var(--brand-500)' }} />
          </div>
        ) : revisionData?.data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              <span className="font-medium text-[13px]" style={{ color: 'var(--text-primary)' }}>{revisionData.data.subject}</span>
              <span>saved {safeDate(revisionData.data.createdAt)}</span>
            </div>
            <div className="text-[14px] leading-relaxed max-h-[55vh] overflow-y-auto rounded-md p-3" style={{ color: 'var(--text-primary)', background: 'var(--surface-raised)' }}>
              {revisionData.data.bodyHtml ? <LetterBodyView content={revisionData.data.bodyHtml} /> : 'This revision has no body content.'}
            </div>
          </div>
        ) : (
          <p className="text-[13px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>Failed to load revision.</p>
        )}
      </Modal>

      <Modal isOpen={editing} onClose={() => setEditing(false)} title="Edit draft" size="lg">
        <div className="space-y-3">
          <input value={editForm.subject} onChange={(e) => setEditForm((f) => ({ ...f, subject: e.target.value }))} className="ui-input w-full" maxLength={500} />
          <LetterBodyEditor content={editForm.bodyHtml} onChange={(json) => setEditForm((f) => ({ ...f, bodyHtml: json }))} />
          <div className="flex justify-end gap-2"><button onClick={() => setEditing(false)} className="ui-btn ui-btn-secondary">Cancel</button><button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="ui-btn ui-btn-primary">Save changes</button></div>
        </div>
      </Modal>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p><p className="text-[13px] mt-0.5 truncate" style={{ color: 'var(--text-primary)' }} title={value}>{value}</p></div>;
}