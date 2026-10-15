'use client';

// Platform-admin-only viewer for GET /workflow/instances and
// GET /workflow/instances/:id(/tasks) — these existed on the backend
// (workflow.routes.ts) with no frontend surface at all until now (only the
// task-queue sub-routes were used, via WorkflowTasksPanel). Read-only: acting
// on a task still happens from the Workflow Queue panel.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ClipboardList, ChevronRight, X } from 'lucide-react';
import { apiClient } from '../../shared/lib/apiClient';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';

const PAGE_SIZE = 20;

type WorkflowInstance = {
  id: string;
  status: string;
  createdAt: string;
  document?: { id: string; filename: string; status: string } | null;
  workflowDefinition?: { id: string; name: string; version: number } | null;
};

type WorkflowTaskRow = {
  id: string;
  stageName: string;
  stageNumber: number;
  assignedToRole: string | null;
  status: string;
  decision: string | null;
  decidedAt: string | null;
  slaDeadlineAt: string | null;
};

function statusBadge(status: string) {
  const tone =
    status === 'COMPLETED' ? 'bg-green-100 text-green-700'
    : status === 'REJECTED' || status === 'CANCELLED' ? 'bg-red-100 text-red-700'
    : 'bg-amber-100 text-amber-700';
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${tone}`}>{status}</span>;
}

function InstanceDetail({ instanceId, onClose }: { instanceId: string; onClose: () => void }) {
  const { data: instanceData, isLoading: loadingInstance } = useQuery({
    queryKey: ['workflow-instance', instanceId],
    queryFn: () => apiClient<{ data: WorkflowInstance }>(`/workflow/instances/${instanceId}`),
  });
  const { data: tasksData, isLoading: loadingTasks } = useQuery({
    queryKey: ['workflow-instance-tasks', instanceId],
    queryFn: () => apiClient<{ data: WorkflowTaskRow[] }>(`/workflow/instances/${instanceId}/tasks`),
  });

  const instance = instanceData?.data;
  const tasks = tasksData?.data ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface-card rounded-2xl shadow-2xl w-full max-w-2xl border border-border max-h-[85vh] overflow-y-auto">
        <div className="p-6 border-b border-border-subtle flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-text-primary">Workflow Instance</h2>
            {instance?.document && (
              <p className="text-sm text-text-muted mt-1 font-mono">{instance.document.filename}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-raised">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          {loadingInstance ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : instance ? (
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <p className="text-xs font-bold text-text-muted uppercase tracking-wide">Status</p>
                {statusBadge(instance.status)}
              </div>
              <div>
                <p className="text-xs font-bold text-text-muted uppercase tracking-wide">Definition</p>
                <p className="text-text-primary font-medium">
                  {instance.workflowDefinition?.name ?? '—'}
                  {instance.workflowDefinition?.version ? ` v${instance.workflowDefinition.version}` : ''}
                </p>
              </div>
              <div>
                <p className="text-xs font-bold text-text-muted uppercase tracking-wide">Started</p>
                <p className="text-text-primary">{format(new Date(instance.createdAt), 'PPp')}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-red-600">Instance not found.</p>
          )}

          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-text-muted mb-2">Stages / Tasks</h3>
            {loadingTasks ? (
              <p className="text-sm text-text-muted">Loading…</p>
            ) : tasks.length === 0 ? (
              <p className="text-sm text-text-muted">No tasks recorded for this instance.</p>
            ) : (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <div key={task.id} className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle p-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        {task.stageNumber}. {task.stageName}
                      </p>
                      <p className="text-xs text-text-muted">
                        {task.assignedToRole ?? 'Unassigned'}
                        {task.decidedAt ? ` · decided ${format(new Date(task.decidedAt), 'PP')}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {task.decision && (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${task.decision === 'APPROVED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {task.decision}
                        </span>
                      )}
                      {statusBadge(task.status)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkflowInstancesPanel() {
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['workflow-instances', page],
    queryFn: () =>
      apiClient<{ data: WorkflowInstance[]; pagination?: { total: number } }>(
        `/workflow/instances?page=${page}&limit=${PAGE_SIZE}`,
      ),
    staleTime: 30_000,
  });

  const instances = data?.data ?? [];
  const total = data?.pagination?.total ?? instances.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <ClipboardList className="h-5 w-5" /> Workflow Instances
        </h2>
        <p className="text-text-muted mt-1 text-sm">
          Every workflow instance across the tenant — not just the ones assigned to you.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm divide-y divide-border-subtle">
          <thead>
            <tr className="text-xs font-semibold text-text-muted uppercase bg-surface-raised">
              <th className="px-4 py-3 text-left">Document</th>
              <th className="px-4 py-3 text-left">Definition</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Started</th>
              <th className="px-4 py-3 text-right">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td>
              </tr>
            )}
            {!isLoading && instances.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-text-muted">No workflow instances found.</td>
              </tr>
            )}
            {!isLoading &&
              instances.map((instance) => (
                <tr key={instance.id} className="hover:bg-surface-raised/60">
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">
                    {instance.document?.filename ?? instance.id}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {instance.workflowDefinition?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3">{statusBadge(instance.status)}</td>
                  <td className="px-4 py-3 text-text-muted">
                    {format(new Date(instance.createdAt), 'PP')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedId(instance.id)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700"
                    >
                      View <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-4">
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={page * PAGE_SIZE < total}
            totalPages={totalPages}
            isLoading={isLoading}
          />
        </div>
      )}

      {selectedId && <InstanceDetail instanceId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
