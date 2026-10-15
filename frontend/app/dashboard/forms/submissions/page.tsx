'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { FileText, ExternalLink, Pencil, Undo2, XCircle, Send } from 'lucide-react';
import {
  cancelFormInstance, getFormInstance, listFormInstances, updateFormInstance, withdrawFormInstance,
  type FormInstanceSummary,
} from '../../../../features/forms/api';
import { ApprovalChainCard } from '../../../../features/approvals/ApprovalChainCard';
import { submitForApproval } from '../../../../features/approvals/api';
import { approvalErrorMessage } from '../../../../features/approvals/errors';
import { FillFormModal } from '../../../../features/forms/components/FillFormModal';
import { filerActionsFor } from '../../../../features/forms/instanceActions';
import { useModalA11y } from '../../../../shared/hooks/useModalA11y';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { EmptyState } from '../../../../shared/components/EmptyState';
import { StatusBadge } from '../../../../shared/components/ui/StatusBadge';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { useAuthStore } from '../../../../state/auth.store';
import { useUIStore } from '../../../../state/ui.store';

const PAGE_SIZE = 25;

function safeDate(value: unknown): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, 'MMM d, yyyy HH:mm');
}

/** Confirm + optional reason for withdrawing a form from review or abandoning it. */
function ReasonDialog({
  title, body, confirmLabel, danger, pending, onConfirm, onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  useModalA11y(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="absolute inset-0" onClick={onClose} role="presentation" />
      <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="form-reason-dialog-title">
        <h3 id="form-reason-dialog-title" className="text-sm font-bold mb-2">{title}</h3>
        <p className="text-xs text-text-muted mb-3">{body}</p>
        <label className="text-xs font-semibold block mb-1" htmlFor="form-reason-dialog-reason">Reason (optional)</label>
        <textarea
          id="form-reason-dialog-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="ui-input w-full min-h-[70px] text-sm mb-3"
          placeholder="Kept in the audit trail"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="ui-btn ui-btn-secondary text-xs">Back</button>
          <button
            onClick={() => onConfirm(reason)}
            disabled={pending}
            className={`ui-btn text-xs ${danger ? 'ui-btn-danger' : 'ui-btn-primary'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FormSubmissionsPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const userId = useAuthStore((s) => s.userId);
  const qc = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // The filer's own pre-approval lifecycle: edit, abandon, recall from review.
  const [editing, setEditing] = useState<FormInstanceSummary | null>(null);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: 'cancel' | 'withdraw'; instance: FormInstanceSummary } | null>(null);
  // After a successful edit: offer to send the form for approval straight away.
  const [submitOfferId, setSubmitOfferId] = useState<string | null>(null);

  const refreshAfterChange = (inst: FormInstanceSummary) => {
    qc.invalidateQueries({ queryKey: ['forms', 'instances'] });
    qc.invalidateQueries({ queryKey: ['documents'] });
    if (inst.documentId) qc.invalidateQueries({ queryKey: ['document', inst.documentId] });
    qc.invalidateQueries({ queryKey: ['approval-chain', 'FORM_INSTANCE', inst.id] });
    qc.invalidateQueries({ queryKey: ['my-work'] });
    qc.invalidateQueries({ queryKey: ['my-work-count'] });
  };

  const updateMutation = useMutation({
    mutationFn: (vars: { instance: FormInstanceSummary; dataJson: Record<string, unknown>; files: Record<string, File> }) =>
      updateFormInstance(vars.instance.id, vars.dataJson, vars.files),
    onSuccess: (_res, vars) => {
      toast.success('Changes saved');
      setEditing(null);
      setSubmitOfferId(vars.instance.id);
      refreshAfterChange(vars.instance);
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Could not save your changes')),
  });

  const submitMutation = useMutation({
    mutationFn: (inst: FormInstanceSummary) => submitForApproval('FORM_INSTANCE', inst.id),
    onSuccess: (_res, inst) => {
      toast.success('Submitted for approval');
      setSubmitOfferId(null);
      refreshAfterChange(inst);
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Submit failed')),
  });

  const cancelMutation = useMutation({
    mutationFn: (vars: { instance: FormInstanceSummary; reason: string }) => cancelFormInstance(vars.instance.id, vars.reason),
    onSuccess: (_res, vars) => {
      toast.success('Submission cancelled');
      setConfirming(null);
      refreshAfterChange(vars.instance);
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Could not cancel the submission')),
  });

  const withdrawMutation = useMutation({
    mutationFn: (vars: { instance: FormInstanceSummary; reason: string }) => withdrawFormInstance(vars.instance.id, vars.reason),
    onSuccess: (_res, vars) => {
      toast.success('Withdrawn from review - it is a draft again, so you can edit it and submit it again');
      setConfirming(null);
      refreshAfterChange(vars.instance);
    },
    onError: (e: unknown) => toast.error(approvalErrorMessage(e, 'Could not withdraw the submission')),
  });

  // The list rows carry no saved answers or template layout, so the full instance is fetched when Edit is clicked.
  const openEdit = async (inst: FormInstanceSummary) => {
    setLoadingEditId(inst.id);
    try {
      const res = await getFormInstance(inst.id);
      setEditing({ ...inst, ...res.data });
    } catch (e) {
      toast.error(approvalErrorMessage(e, 'Could not open the form for editing'));
    } finally {
      setLoadingEditId(null);
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['forms', 'instances', 'mine', userId, page],
    queryFn: () => listFormInstances({ createdBy: userId ?? undefined }, (page - 1) * PAGE_SIZE, PAGE_SIZE),
    enabled: Boolean(userId),
  });

  const instances = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar
        title="Forms"
        breadcrumbs={[{ label: 'Forms', href: '/dashboard/forms/templates' }, { label: 'My Submissions' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader title="My Submissions" subtitle="Forms you've filled out, and their approval progress." />

        {isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading submissions...</div>
        ) : instances.length === 0 ? (
          <EmptyState icon={FileText} title="No submissions yet" description="Forms you fill out will show up here along with their approval status." />
        ) : (
          <div className="space-y-2">
            {instances.map((inst) => (
              <div key={inst.id} className="ui-card">
                <div className="flex items-center gap-3">
                  <FileText size={18} style={{ color: 'var(--text-tertiary)' }} className="shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{inst.template?.name ?? 'Form'}</span>
                      {/* The number people actually quote. Allocated at final
                          approval, so its presence is also the plainest signal
                          that a submission cleared its chain. */}
                      {inst.referenceNumber && (
                        <span
                          className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
                          data-testid="submission-reference"
                        >
                          {inst.referenceNumber}
                        </span>
                      )}
                      {inst.document && <StatusBadge status={inst.document.status} />}
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }} data-testid="submission-meta">
                      Filled {safeDate(inst.createdAt)}
                      {/* Where it was filed. A submission belongs to a department
                          and, through it, an org unit — exactly like every other
                          document — but nothing here ever said so, which is why
                          "the forms module needs to have department etc as the
                          rest" was a fair complaint. */}
                      {inst.document?.department && (
                        <>
                          {' · '}
                          {inst.document.department.orgUnit && (
                            <span title={inst.document.department.orgUnit.name}>{inst.document.department.orgUnit.code} / </span>
                          )}
                          <span title={inst.document.department.name}>{inst.document.department.code}</span>
                        </>
                      )}
                    </p>
                  </div>
                  {/* The filer's own lifecycle actions, by the backing document's status (instanceActions.ts). */}
                  {filerActionsFor({
                    status: inst.document?.status,
                    instanceApproval: inst.template?.instanceApproval,
                    createdBy: inst.createdBy,
                    currentUserId: userId,
                  }).map((action) => {
                    if (action === 'edit') {
                      return (
                        <button key={action} onClick={() => void openEdit(inst)} disabled={loadingEditId === inst.id}
                          className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0" data-testid="submission-edit">
                          <Pencil size={13} /> {loadingEditId === inst.id ? 'Opening…' : 'Edit'}
                        </button>
                      );
                    }
                    if (action === 'cancel') {
                      return (
                        <button key={action} onClick={() => setConfirming({ kind: 'cancel', instance: inst })}
                          className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0" data-testid="submission-cancel">
                          <XCircle size={13} /> Cancel submission
                        </button>
                      );
                    }
                    return (
                      <button key={action} onClick={() => setConfirming({ kind: 'withdraw', instance: inst })}
                        className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0" data-testid="submission-withdraw">
                        <Undo2 size={13} /> Withdraw from review
                      </button>
                    );
                  })}
                  {inst.documentId && (
                    <Link href={`/dashboard/documents/${inst.documentId}`} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">
                      <ExternalLink size={13} /> Open document
                    </Link>
                  )}
                  <button
                    onClick={() => setExpandedId((cur) => (cur === inst.id ? null : inst.id))}
                    className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0"
                  >
                    {expandedId === inst.id ? 'Hide approval' : 'Approval status'}
                  </button>
                </div>
                {/* Right after an edit: offer to send it for approval. */}
                {submitOfferId === inst.id && ['DRAFT', 'CHANGES_REQUESTED', 'DECLINED'].includes(inst.document?.status ?? '') && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }} data-testid="submission-submit-offer">
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      Your changes are saved. Send it for approval now?
                    </span>
                    <button onClick={() => submitMutation.mutate(inst)} disabled={submitMutation.isPending} className="ui-btn ui-btn-primary !py-1 text-xs">
                      <Send size={13} /> Submit for approval
                    </button>
                    <button onClick={() => { setExpandedId(inst.id); setSubmitOfferId(null); }} className="ui-btn ui-btn-secondary !py-1 text-xs"
                      title="Open the approval panel to pick the approvers yourself">
                      Choose approvers
                    </button>
                    <button onClick={() => setSubmitOfferId(null)} className="ui-btn ui-btn-secondary !py-1 text-xs">Not now</button>
                  </div>
                )}
                {expandedId === inst.id && inst.documentId && (
                  <ApprovalChainCard
                    documentId={inst.documentId}
                    documentStatus={inst.document?.status ?? ''}
                    ownerId={null}
                    auditPolicy={inst.template?.auditPolicy ?? 'never'}
                    itemType="FORM_INSTANCE"
                    itemId={inst.id}
                    signatureRequests={inst.document?.signatureRequests}
                    departmentId={inst.document?.department?.id ?? null}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {editing && editing.template && (
          <FillFormModal
            template={editing.template}
            departments={[]}
            existingInstance={{ id: editing.id, dataJson: editing.dataJson }}
            onClose={() => setEditing(null)}
            isSubmitting={updateMutation.isPending}
            onSubmit={(payload) => updateMutation.mutate({ instance: editing, dataJson: payload.dataJson, files: payload.files })}
          />
        )}

        {confirming?.kind === 'cancel' && (
          <ReasonDialog
            title="Cancel this submission"
            body="The form is abandoned and cannot be reopened. To file it again you start a new one."
            confirmLabel="Cancel submission"
            danger
            pending={cancelMutation.isPending}
            onClose={() => setConfirming(null)}
            onConfirm={(reason) => cancelMutation.mutate({ instance: confirming.instance, reason })}
          />
        )}
        {confirming?.kind === 'withdraw' && (
          <ReasonDialog
            title="Withdraw from review"
            body="The running approval is cancelled and the form goes back to Draft. You can then edit it and submit it for approval again."
            confirmLabel="Withdraw"
            pending={withdrawMutation.isPending}
            onClose={() => setConfirming(null)}
            onConfirm={(reason) => withdrawMutation.mutate({ instance: confirming.instance, reason })}
          />
        )}

        {total > PAGE_SIZE && (
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={page < totalPages}
            totalPages={totalPages}
            isLoading={isLoading}
          />
        )}
      </div>
    </>
  );
}
