'use client';

import { useState } from 'react';
import {
  useWorkflowTasksPage,
  useSubmitTaskDecision,
} from '../documents/hooks';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import Link from 'next/link';
import {
  ClipboardList,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Inbox,
  Pen,
  Timer,
} from 'lucide-react';

function SlaIndicator({ deadline }: { deadline: string }) {
  const date = new Date(deadline);
  const breached = isPast(date);
  const distanceText = formatDistanceToNow(date, { addSuffix: true });
  if (breached) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
        <AlertTriangle className="h-3 w-3" /> SLA BREACHED {distanceText}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
      <Timer className="h-3 w-3" /> Due {distanceText}
    </span>
  );
}

function DecisionModal({
  task,
  onClose,
  onSubmit,
  isPending,
}: {
  task: any;
  onClose: () => void;
  onSubmit: (
    taskId: string,
    decision: 'APPROVE' | 'REJECT',
    reason?: string,
  ) => void;
  isPending: boolean;
}) {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);

  const canSubmit =
    decision !== null &&
    (decision === 'APPROVE' || reason.trim().length >= 10) &&
    (decision !== 'APPROVE' || consent);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface-card rounded-2xl shadow-2xl w-full max-w-lg border border-border">
        <div className="p-6 border-b border-border-subtle">
          <h2 className="text-xl font-bold text-text-primary">Action Required</h2>
          <p className="text-sm text-text-muted mt-1">
            <span className="font-semibold text-indigo-700">
              {task.stageName}
            </span>{' '}
            — {task.workflowInstance.document.documentName}
          </p>
        </div>
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setDecision('APPROVE')}
              className={`p-4 rounded-xl border-2 transition-all font-bold text-sm flex items-center gap-2 justify-center ${
                decision === 'APPROVE'
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-border text-text-secondary hover:border-green-300'
              }`}
            >
              <CheckCircle2 className="h-4 w-4" /> Approve
            </button>
            <button
              onClick={() => setDecision('REJECT')}
              className={`p-4 rounded-xl border-2 transition-all font-bold text-sm flex items-center gap-2 justify-center ${
                decision === 'REJECT'
                  ? 'border-red-500 bg-red-50 text-red-700'
                  : 'border-border text-text-secondary hover:border-red-300'
              }`}
            >
              <XCircle className="h-4 w-4" /> Reject
            </button>
          </div>

          {decision === 'REJECT' && (
            <div>
              <label className="block text-xs font-bold text-text-secondary uppercase tracking-wider mb-2">
                Rejection Reason <span className="text-red-500">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Provide a detailed reason (min. 10 characters)..."
                className="w-full rounded-xl border border-border p-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 resize-none bg-surface-card"
              />
              {reason.trim().length > 0 && reason.trim().length < 10 && (
                <p className="text-xs text-red-500 mt-1">
                  Reason must be at least 10 characters.
                </p>
              )}
            </div>
          )}

          {decision === 'APPROVE' && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-xs text-text-secondary leading-relaxed">
                <span className="font-bold text-text-primary">
                  Electronic Signature Consent:
                </span>{' '}
                I confirm that by clicking Approve, I am providing my legally
                binding electronic approval in accordance with the document
                governance policy.
              </span>
            </label>
          )}
        </div>
        <div className="p-6 pt-0 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-semibold text-text-secondary bg-surface-hover hover:bg-surface-raised rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!canSubmit || isPending}
            onClick={() => {
              if (!decision) return;
              // Closing only happens in onSubmit's onSuccess (WorkflowTasksPanel
              // below) — closing unconditionally here used to hide a failed
              // decision behind a vanished modal, the same "click and nothing
              // visibly happens" bug as the e-signing Send button.
              onSubmit(
                task.id,
                decision,
                decision === 'REJECT' ? reason : undefined,
              );
            }}
            className={`px-5 py-2.5 text-sm font-semibold text-white rounded-xl transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
              decision === 'APPROVE'
                ? 'bg-green-600 hover:bg-green-700 shadow-lg shadow-green-100'
                : 'bg-red-600 hover:bg-red-700 shadow-lg shadow-red-100'
            }`}
          >
            <Pen className="h-3.5 w-3.5" />
            {isPending
              ? 'Processing...'
              : decision === 'APPROVE'
                ? 'Sign & Approve'
                : 'Submit Rejection'}
          </button>
        </div>
      </div>
    </div>
  );
}

const WORKFLOW_PAGE_SIZE = 15;

export function WorkflowTasksPanel() {
  const { mutate: submitDecision, isPending } = useSubmitTaskDecision();
  const [activeTask, setActiveTask] = useState<any | null>(null);
  const [pendingPage, setPendingPage] = useState(1);
  const [completedPage, setCompletedPage] = useState(1);

  // Two independent paged queries (15/page). Previously a single unparameterized
  // fetch returned only the PENDING page (endpoint default), so "Recently
  // Completed" was always empty and neither list paged.
  const { data: pendingData, isLoading } = useWorkflowTasksPage({ page: pendingPage, limit: WORKFLOW_PAGE_SIZE, status: 'PENDING' });
  const { data: completedData } = useWorkflowTasksPage({ page: completedPage, limit: WORKFLOW_PAGE_SIZE, status: 'COMPLETED' });

  const pending = pendingData?.data ?? [];
  const pendingTotal = pendingData?.total ?? pending.length;
  const pendingTotalPages = Math.max(1, Math.ceil(pendingTotal / WORKFLOW_PAGE_SIZE));
  const completed = completedData?.data ?? [];
  const completedTotal = completedData?.total ?? completed.length;
  const completedTotalPages = Math.max(1, Math.ceil(completedTotal / WORKFLOW_PAGE_SIZE));

  return (
    <>
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-text-primary">Workflow Queue</h2>
          <p className="text-text-muted mt-1">
            Review documents assigned to your governance role.
          </p>
        </div>
        <div className="flex gap-4">
          <div className="bg-surface-card rounded-xl shadow-sm ring-1 ring-border px-5 py-3 text-center">
            <p className="text-2xl font-bold text-text-primary">
              {pendingTotal}
            </p>
            <p className="text-xs text-text-muted font-semibold uppercase tracking-wide mt-0.5">
              Pending
            </p>
          </div>
          <div className="bg-surface-card rounded-xl shadow-sm ring-1 ring-border px-5 py-3 text-center">
            <p className="text-2xl font-bold text-text-primary">
              {completedTotal}
            </p>
            <p className="text-xs text-text-muted font-semibold uppercase tracking-wide mt-0.5">
              Completed
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-16">
          <div className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-solid border-indigo-600 border-r-transparent" />
          <p className="mt-4 text-text-muted">Loading your queue...</p>
        </div>
      ) : pending.length === 0 && completed.length === 0 ? (
        <div className="bg-surface-card rounded-2xl shadow-sm ring-1 ring-border p-16 text-center">
          <Inbox className="h-12 w-12 text-text-muted mx-auto mb-4" />
          <h3 className="text-lg font-bold text-text-primary">Queue Clear</h3>
          <p className="text-text-muted mt-1 text-sm">
            No pending tasks require your attention.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.length > 0 && (
          <h2 className="text-xs font-bold uppercase tracking-widest text-text-muted flex items-center gap-2">
            <ClipboardList className="h-4 w-4" /> Pending Action (
            {pendingTotal})
          </h2>
          )}
          {pending.map((task: any) => (
            <div
              key={task.id}
              className="bg-surface-card rounded-2xl shadow-sm ring-1 ring-border p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:shadow-md transition-shadow"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                    {task.stageName}
                  </span>
                  <SlaIndicator deadline={task.slaDeadlineAt} />
                  {task.isSlaBreach && (
                    <span className="text-xs font-bold text-white bg-red-600 px-2 py-0.5 rounded-full">
                      ESCALATED
                    </span>
                  )}
                </div>
                <h3 className="text-lg font-bold text-text-primary truncate">
                  {task.workflowInstance?.document?.title}
                </h3>
                <p className="text-sm text-text-muted font-mono">
                  {task.workflowInstance?.document?.documentName}
                </p>
                <p className="text-xs text-text-muted mt-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Assigned {format(new Date(task.createdAt), 'PPp')}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Link
                  href={`/dashboard/documents/${task.workflowInstance?.document?.id}?tab=workflow`}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-text-secondary bg-surface-hover hover:bg-surface-raised rounded-xl border border-border transition-colors"
                >
                  View <ChevronRight className="h-3.5 w-3.5" />
                </Link>
                <button
                  onClick={() => setActiveTask(task)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md shadow-indigo-100 transition-all"
                >
                  <Pen className="h-3.5 w-3.5" /> Act
                </button>
              </div>
            </div>
          ))}

          {pendingTotal > WORKFLOW_PAGE_SIZE && (
            <PaginationControls
              page={pendingPage}
              onPageChange={setPendingPage}
              hasPrevious={pendingPage > 1}
              hasNext={pendingPage * WORKFLOW_PAGE_SIZE < pendingTotal}
              totalPages={pendingTotalPages}
              isLoading={isLoading}
            />
          )}

          {completed.length > 0 && (
            <>
              <h2 className="text-xs font-bold uppercase tracking-widest text-text-muted flex items-center gap-2 mt-8">
                <CheckCircle2 className="h-4 w-4" /> Recently Completed (
                {completedTotal})
              </h2>
              {completed.map((task: any) => (
                <div
                  key={task.id}
                  className="bg-surface-hover rounded-2xl ring-1 ring-border p-4 flex justify-between items-center opacity-75"
                >
                  <div>
                    <span className="text-xs font-bold text-text-muted uppercase">
                      {task.stageName}
                    </span>
                    <p className="text-sm font-semibold text-text-primary">
                      {task.workflowInstance?.document?.title}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-bold px-2.5 py-1 rounded-full ${task.decision === 'APPROVE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                  >
                    {task.decision}
                  </span>
                </div>
              ))}
              {completedTotal > WORKFLOW_PAGE_SIZE && (
                <PaginationControls
                  page={completedPage}
                  onPageChange={setCompletedPage}
                  hasPrevious={completedPage > 1}
                  hasNext={completedPage * WORKFLOW_PAGE_SIZE < completedTotal}
                  totalPages={completedTotalPages}
                />
              )}
            </>
          )}
        </div>
      )}

      {activeTask && (
        <DecisionModal
          task={activeTask}
          onClose={() => setActiveTask(null)}
          onSubmit={(taskId, decision, reason) =>
            submitDecision({ taskId, decision, reason }, { onSuccess: () => setActiveTask(null) })
          }
          isPending={isPending}
        />
      )}
    </>
  );
}
