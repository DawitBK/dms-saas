'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import {
  FileText,
  Inbox,
  Clock,
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
  Timer,
  Search,
  Archive,
  ArrowUpRight,
  Users,
} from 'lucide-react';
import { StatCard } from '../../shared/components/StatCard';
import { ErrorState } from '../../shared/components/ErrorState';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import { useDashboardStats, useWorkflowTasks } from '../documents/hooks';
import { listDocuments } from '../documents/api';
import { useAuthStore } from '../../state/auth.store';

// 15/page, matching the project-wide pagination convention (see
// documents.routes.ts skip/take + shared/components/ui/PaginationControls.tsx).
const RECENT_ACTIVITY_PAGE_SIZE = 15;

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-text-secondary',
  ACTIVE: 'bg-green-100 text-green-700',
  ARCHIVED: 'bg-blue-100 text-blue-700',
  UNDER_REVIEW: 'bg-yellow-100 text-yellow-700',
  DISPOSAL_PENDING: 'bg-orange-100 text-orange-700',
  DISPOSED: 'bg-red-100 text-red-700',
  IN_REVIEW: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  APPROVED: 'bg-green-100 text-green-700',
  PENDING_SIGNATURE: 'bg-purple-100 text-purple-700',
};

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

export function ManagerHubPanel() {
  const { userId, role } = useAuthStore();
  const { data: tasks, isLoading: tasksLoading, isError: tasksError, error: tasksErrorObj, refetch: refetchTasks } = useWorkflowTasks();
  const { data: dashboardStats, isLoading: statsLoading, isError: statsError, error: statsErrorObj, refetch: refetchStats } = useDashboardStats();

  const taskList: any[] = tasks ?? [];

  const totalDocs = dashboardStats?.total ?? 0;
  // FIX: these used to come from client-side-counting the ACL-filtered
  // useDocuments() feed (which triggers the resolveACL N+1 per row) purely to
  // count two aggregates — useDashboardStats() already computes both
  // tenant-wide, server-side.
  const activeDocs = dashboardStats?.byStatus?.ACTIVE ?? 0;
  const onHold = dashboardStats?.onLegalHold ?? 0;
  const pendingApprovals = taskList.filter(
    (t) => t.status === 'PENDING',
  ).length;

  // Recent Department Activity — its own real backend-paginated query (15/page)
  // instead of slicing the top 20 of the (already-capped) useDocuments() feed.
  // The backend already orders documents by updatedAt DESC (documents.service.ts
  // listDocuments), so no client-side re-sort is needed.
  const [recentPage, setRecentPage] = useState(1);
  const {
    data: recentActivityPage,
    isLoading: recentLoading,
    isError: recentError,
    error: recentErrorObj,
    refetch: refetchRecent,
  } = useQuery({
    queryKey: ['documents-recent-activity', `${userId}:${role}`, recentPage],
    queryFn: () =>
      listDocuments((recentPage - 1) * RECENT_ACTIVITY_PAGE_SIZE, RECENT_ACTIVITY_PAGE_SIZE),
    enabled: Boolean(userId && role),
    staleTime: 30_000,
  });
  const recentDocs = recentActivityPage?.data ?? [];
  const recentTotal = recentActivityPage?.total ?? recentDocs.length;
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / RECENT_ACTIVITY_PAGE_SIZE));

  const pendingTasks = taskList.filter((t) => t.status === 'PENDING');
  const hasQueryError = tasksError || statsError || recentError;
  // First one that's actually set — this banner represents "at least one of
  // three independent queries failed," so show whichever real error/retry
  // instead of inventing one combined message that would hide which query
  // is genuinely broken.
  const firstError = tasksErrorObj ?? statsErrorObj ?? recentErrorObj;
  const retryAll = () => {
    if (tasksError) refetchTasks();
    if (statsError) refetchStats();
    if (recentError) refetchRecent();
  };

  return (
    <>
      <div className="mb-8 flex flex-col md:flex-row justify-between items-start gap-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary">
            Department Manager Hub
          </h2>
          <p className="text-text-muted mt-1">
            Review department activity, monitor approval workload, and act on
            pending tasks.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-full text-xs font-bold border border-indigo-100">
          <Users className="h-3.5 w-3.5" /> Manager Workspace
        </div>
      </div>

      {/* Department Stats Row */}
      {hasQueryError && (
        <div className="ui-card mb-6 p-0">
          <ErrorState error={firstError} title="Some manager hub data couldn't load" onRetry={retryAll} />
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Documents"
          value={statsLoading ? '…' : statsError ? 'Error' : totalDocs}
          icon={FileText}
          color="bg-indigo-50 text-indigo-600"
          hint="In your accessible scope"
          href="/dashboard/documents"
        />
        <StatCard
          label="Active Documents"
          value={statsLoading ? '…' : statsError ? 'Error' : activeDocs}
          icon={CheckCircle2}
          color="bg-green-50 text-green-600"
          hint="Live and queryable"
          href="/dashboard/documents?status=ACTIVE"
        />
        <StatCard
          label="Pending Approvals"
          value={tasksLoading ? '…' : tasksError ? 'Error' : pendingApprovals}
          icon={Inbox}
          color="bg-amber-50 text-amber-600"
          hint="Awaiting your decision"
          href="/operations?panel=workflows"
        />
        <StatCard
          label="On Legal Hold"
          value={statsLoading ? '…' : statsError ? 'Error' : onHold}
          icon={ShieldAlert}
          color="bg-red-50 text-red-600"
          hint="Preserved from disposal"
          href="/operations?panel=legalHold"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Recent Department Activity */}
        <div className="xl:col-span-2 space-y-6">
          <section className="bg-surface-card shadow-sm border border-border rounded-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-border-subtle flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <FileText className="h-5 w-5 text-indigo-600" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-text-primary">
                    Recent Department Activity
                  </h3>
                  <p className="text-xs text-text-muted">
                    {recentTotal > 0
                      ? `${recentTotal} document${recentTotal === 1 ? '' : 's'} in your scope`
                      : 'Documents in your scope'}
                  </p>
                </div>
              </div>
              <Link
                href="/dashboard"
                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
              >
                View All <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            {recentLoading ? (
              <div className="p-12 text-center">
                <RefreshCw className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-3" />
                <p className="text-text-muted text-sm">
                  Loading department documents…
                </p>
              </div>
            ) : recentDocs.length === 0 ? (
              <div className="p-12 text-center">
                <FileText className="h-10 w-10 text-text-muted mx-auto mb-3" />
                <p className="text-text-muted text-sm">
                  No documents to review yet.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border-subtle text-sm">
                  <thead className="bg-surface-raised">
                    <tr className="text-[10px] font-black text-text-muted uppercase tracking-widest">
                      <th className="px-6 py-3 text-left">Document</th>
                      <th className="px-6 py-3 text-left">Status</th>
                      <th className="px-6 py-3 text-left">Type</th>
                      <th className="px-6 py-3 text-left">Owner</th>
                      <th className="px-6 py-3 text-right">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {recentDocs.map((doc: any) => (
                      <tr
                        key={doc.id}
                        className="hover:bg-surface-hover/80 transition-colors group"
                      >
                        <td className="px-6 py-3.5">
                          <Link
                            href={`/dashboard/documents/${doc.id}`}
                            className="flex flex-col"
                          >
                            <span className="text-sm font-semibold text-text-primary group-hover:text-indigo-700 transition-colors truncate max-w-xs">
                              {doc.title}
                            </span>
                            <span className="text-[11px] text-text-muted font-mono">
                              {doc.documentName}
                            </span>
                          </Link>
                        </td>
                        <td className="px-6 py-3.5">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold ${STATUS_COLORS[doc.status] ?? 'bg-surface-raised text-text-secondary'}`}
                          >
                            {doc.status}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-xs text-text-secondary">
                          {doc.documentType?.name}
                        </td>
                        <td className="px-6 py-3.5 text-xs text-text-secondary">
                          {doc.owner
                            ? `${doc.owner.firstName} ${doc.owner.lastName}`
                            : '—'}
                        </td>
                        <td className="px-6 py-3.5 text-right text-xs text-text-muted">
                          {format(new Date(doc.updatedAt), 'MMM d, yyyy')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {recentTotal > RECENT_ACTIVITY_PAGE_SIZE && (
              <div className="px-6">
                <PaginationControls
                  page={recentPage}
                  onPageChange={setRecentPage}
                  hasPrevious={recentPage > 1}
                  hasNext={recentPage * RECENT_ACTIVITY_PAGE_SIZE < recentTotal}
                  totalPages={recentTotalPages}
                  isLoading={recentLoading}
                />
              </div>
            )}
          </section>

          {/* Approval Queue */}
          <section className="bg-surface-card shadow-sm border border-border rounded-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-border-subtle flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-50 rounded-lg">
                  <Inbox className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-text-primary">
                    Approval Queue
                  </h3>
                  <p className="text-xs text-text-muted">
                    Tasks waiting on your decision
                  </p>
                </div>
              </div>
            </div>
            {tasksLoading ? (
              <div className="p-12 text-center">
                <RefreshCw className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-3" />
                <p className="text-text-muted text-sm">Loading your queue…</p>
              </div>
            ) : pendingTasks.length === 0 ? (
              <div className="p-12 text-center">
                <CheckCircle2 className="h-10 w-10 text-green-300 mx-auto mb-3" />
                <p className="text-text-muted text-sm font-medium">
                  Queue clear
                </p>
                <p className="text-xs text-text-muted mt-1">
                  No pending tasks require your attention.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {pendingTasks.map((task: any) => (
                  <li
                    key={task.id}
                    className="px-6 py-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 hover:bg-surface-hover/60 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <span className="text-[10px] font-black text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase tracking-widest">
                          {task.stageName}
                        </span>
                        <SlaIndicator deadline={task.slaDeadlineAt} />
                      </div>
                      <p className="text-sm font-bold text-text-primary truncate">
                        {task.workflowInstance?.document?.title}
                      </p>
                      <p className="text-[11px] text-text-muted font-mono truncate">
                        {task.workflowInstance?.document?.documentName}
                      </p>
                    </div>
                    <Link
                      // The document detail page's Workflow tab only shows a
                      // read-only stage timeline (no decide UI) — the real
                      // Act button + decision modal for this exact task list
                      // lives in Operations → Workflow Queue (same
                      // useWorkflowTasks() data as this panel).
                      href="/operations?panel=workflows"
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md shadow-indigo-100 transition-all"
                    >
                      Review & Act{' '}
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Quick Actions panel */}
        <aside className="space-y-6">
          <section className="bg-gradient-to-br from-brand-900 to-indigo-900 rounded-2xl p-6 text-white shadow-lg">
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-300 mb-4 flex items-center gap-2">
              <Clock className="h-3.5 w-3.5" /> Quick Actions
            </h3>
            <div className="space-y-2">
              <Link
                href="/dashboard/search"
                className="flex items-center justify-between p-3 rounded-xl bg-white/10 hover:bg-white/20 border border-white/10 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Search className="h-4 w-4 text-indigo-300" />
                  <span className="text-sm font-bold">Search Documents</span>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-300 group-hover:translate-x-1 transition-transform" />
              </Link>
              <Link
                href="/dashboard"
                className="flex items-center justify-between p-3 rounded-xl bg-white/10 hover:bg-white/20 border border-white/10 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Archive className="h-4 w-4 text-green-300" />
                  <span className="text-sm font-bold">
                    Document Repository
                  </span>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-300 group-hover:translate-x-1 transition-transform" />
              </Link>
            </div>
          </section>

          <section className="bg-surface-card shadow-sm ring-1 ring-border rounded-2xl p-5">
            <h3 className="text-xs font-black text-text-muted uppercase tracking-widest mb-3">
              Manager Tips
            </h3>
            <ul className="space-y-2.5 text-xs text-text-secondary leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-indigo-500 font-bold">→</span>
                Pending approvals must be acted on within their SLA window.
              </li>
              <li className="flex items-start gap-2">
                <span className="text-indigo-500 font-bold">→</span>
                Documents on legal hold cannot be archived or disposed.
              </li>
              <li className="flex items-start gap-2">
                <span className="text-indigo-500 font-bold">→</span>
                Use search to find records by keyword, type, or department.
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
