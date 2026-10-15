'use client';

import Link from 'next/link';
import { format } from 'date-fns';
import {
  FileText,
  CheckCircle2,
  Clock,
  Archive,
  UploadCloud,
  FolderOpen,
  ClipboardCheck,
  ShieldCheck,
  ArrowUpRight,
  AlertTriangle,
  Mail,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import {
  useDashboardStats,
  useWorkflowTasks,
  useAuditLogs,
} from '../../features/documents/hooks';
import { useLetterVolumeReport } from '../../features/letters/hooks';
import { useSystemHealth } from '../../features/settings/hooks';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { MetricCard } from '../../shared/components/ui/MetricCard';
import { StatusBadge } from '../../shared/components/ui/StatusBadge';
import { SkeletonCard } from '../../shared/components/ui/SkeletonRow';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { TopBar } from '../../shared/components/TopBar';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useUIStore } from '../../state/ui.store';

// recharts (LetterVolumeChart) is dynamically imported, ssr:false — keeps the
// chart library out of the main dashboard bundle for visits that never
// scroll to this widget.
const LetterVolumeChart = dynamic(() => import('../../features/letters/LetterVolumeChart'), { ssr: false });

// ─── Status colour palette for the conic-gradient pie chart ──────────────────

const STATUS_PALETTE: Record<string, string> = {
  DRAFT: '#94a3b8',
  PENDING_REVIEW: '#f59e0b',
  IN_REVIEW: '#3b82f6',
  APPROVED: '#10b981',
  ACTIVE: '#059669',
  ARCHIVED: '#64748b',
  REJECTED: '#f43f5e',
  LEGAL_HOLD: '#ef4444',
  DISPOSAL_PENDING: '#f97316',
  DISPOSED: '#6b7280',
};

function safeDate(value: unknown, fmt: string): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

// ─── Pure-CSS conic-gradient pie chart ───────────────────────────────────────

function StatusPieChart({ byStatus }: { byStatus: Record<string, number> }) {
  const entries = Object.entries(byStatus).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-text-muted text-sm">
        No data
      </div>
    );
  }

  // Build conic-gradient segments
  let accumulated = 0;
  const segments = entries.map(([status, count]) => {
    const pct = (count / total) * 100;
    const color = STATUS_PALETTE[status] ?? '#94a3b8';
    const start = accumulated;
    accumulated += pct;
    return { status, count, pct, color, start };
  });

  const gradient = segments
    .map(
      (s) =>
        `${s.color} ${s.start.toFixed(1)}% ${(s.start + s.pct).toFixed(1)}%`,
    )
    .join(', ');

  return (
    <div className="space-y-3">
      <div
        className="mx-auto rounded-full"
        style={{
          width: 120,
          height: 120,
          background: `conic-gradient(${gradient})`,
        }}
      />
      <div className="grid grid-cols-2 gap-1">
        {segments.slice(0, 8).map(({ status, count, color }) => (
          <div
            key={status}
            className="flex items-center gap-1.5 text-xs text-text-secondary"
          >
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ background: color }}
            />
            <span className="truncate">{status.replace(/_/g, ' ')}</span>
            <span className="ml-auto font-mono text-text-muted">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Quick actions — each gated individually via can() ───────────────────────

const QUICK_ACTIONS = [
  {
    label: 'Upload Document',
    href: '/dashboard/upload',
    icon: UploadCloud,
    permission: PERMISSIONS.DOCUMENT_UPLOAD,
    color:
      'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300 dark:hover:bg-indigo-500/25',
  },
  {
    label: 'Browse Files',
    href: '/dashboard/browse',
    icon: FolderOpen,
    permission: PERMISSIONS.FOLDER_READ,
    color:
      'bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25',
  },
  {
    label: 'Approval Queue',
    href: '/operations?panel=workflows',
    icon: ClipboardCheck,
    permission: PERMISSIONS.WORKFLOW_APPROVE,
    color:
      'bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-500/15 dark:text-green-300 dark:hover:bg-green-500/25',
  },
  {
    label: 'Audit Log',
    href: '/operations?panel=audit',
    icon: ShieldCheck,
    permission: PERMISSIONS.AUDIT_READ,
    color:
      'bg-violet-50 text-violet-600 hover:bg-violet-100 dark:bg-violet-500/15 dark:text-violet-300 dark:hover:bg-violet-500/25',
  },
  {
    label: 'Records Console',
    href: '/operations?panel=lifecycle',
    icon: Archive,
    permission: PERMISSIONS.RETENTION_MANAGE,
    color:
      'bg-amber-50 text-amber-600 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25',
  },
  {
    label: 'Administration',
    href: '/operations?panel=users',
    icon: CheckCircle2,
    permission: PERMISSIONS.USER_MANAGE,
    color:
      'bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25',
  },
] as const;

// ─── Secondary panel: Pending Approvals ──────────────────────────────────────

function PendingApprovalsPanel() {
  const { data, isLoading } = useWorkflowTasks();
  const tasks: any[] = (data ?? [])
    .filter((t: any) => t.status === 'PENDING')
    .slice(0, 5);

  if (isLoading) return <SkeletonCard lines={3} />;

  return (
    <div className="ui-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-brand-600" />
          Pending Approvals
        </h3>
        <Link
          href="/operations?panel=workflows"
          className="text-xs text-brand-600 hover:underline font-semibold flex items-center gap-1"
        >
          View all <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {tasks.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-4">
          Queue is clear ✓
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task: any) => (
            <Link
              key={task.id}
              href={`/dashboard/documents/${task.workflowInstance?.document?.id}`}
              className="flex items-start gap-3 p-3 rounded-xl bg-surface-raised/50 hover:bg-surface-raised transition-colors"
            >
              <div className="mt-0.5 h-2 w-2 rounded-full bg-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-text-primary truncate">
                  {task.workflowInstance?.document?.title ?? 'Untitled'}
                </p>
                <p className="text-[11px] text-text-muted mt-0.5">
                  {task.stageName}
                </p>
              </div>
              <span className="text-[10px] font-mono text-text-muted shrink-0">
                {safeDate(task.slaDeadlineAt, 'MMM d')}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Secondary panel: Audit Trail preview ────────────────────────────────────

function AuditPreviewPanel() {
  const { data: logs, isLoading } = useAuditLogs();
  const recent = (logs as any[] | undefined)?.slice(0, 5) ?? [];

  if (isLoading) return <SkeletonCard lines={3} />;

  return (
    <div className="ui-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-violet-500" />
          Recent Audit Events
        </h3>
        <Link
          href="/operations?panel=audit"
          className="text-xs text-brand-600 hover:underline font-semibold flex items-center gap-1"
        >
          Full log <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {recent.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-4">
          No events yet
        </p>
      ) : (
        <div className="space-y-1.5">
          {recent.map((log: any) => (
            <div
              key={log.id}
              className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0"
            >
              <span className="inline-block bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0">
                {log.eventType?.replace(/_/g, ' ')}
              </span>
              <span className="text-[11px] text-text-muted font-mono truncate flex-1">
                {log.userId ?? 'System'}
              </span>
              <span className="text-[10px] text-text-muted shrink-0">
                {safeDate(log.timestamp, 'HH:mm')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Secondary panel: Letter Volume widget ───────────────────────────────────
// Small backend report (GET /reports/letters/volume) rendered as a compact
// recharts line chart — correspondence volume per month, last 6 months.

function LetterVolumeWidget() {
  const { data: report, isLoading } = useLetterVolumeReport();
  const rows = report?.rows ?? [];
  const hasVolume = rows.some((r) => r.total_count > 0);

  return (
    <div className="ui-card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Mail className="h-4 w-4 text-brand-600" />
          Letter Volume
        </h3>
        <Link
          href="/operations?panel=reports"
          className="text-xs text-brand-600 hover:underline font-semibold flex items-center gap-1"
        >
          Full report <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {isLoading ? (
        <div className="ui-skeleton h-40 rounded-xl" />
      ) : !hasVolume ? (
        <p className="text-sm text-text-muted text-center py-10">
          No correspondence in the last 6 months
        </p>
      ) : (
        <LetterVolumeChart rows={rows} />
      )}
    </div>
  );
}

// ─── System health strip ──────────────────────────────────────────────────────

function SystemHealthStrip() {
  const { data: health } = useSystemHealth();
  if (!health) return null;

  const services = [
    { name: 'DB', ok: (health as any).db === 'ok' },
    { name: 'Redis', ok: (health as any).redis === 'ok' },
    { name: 'MinIO', ok: (health as any).minio !== 'error' },
    { name: 'Search', ok: (health as any).meilisearch !== 'error' },
    // DATA-3: `redis: ok` only means Redis itself is reachable right now —
    // it does NOT mean the background workers (retention purge, legal-hold
    // disposal, SLA escalation) are actually running, since they only start
    // once at process boot and stay offline forever if REDIS_URL was unset
    // at that moment. Surfaced separately so that gap is visible here instead
    // of only in a boot-time log line.
    { name: 'Workers', ok: (health as any).workers === 'ok', title: (health as any).workersOfflineReason as string | undefined },
    // STOR-2: uploads succeed either way (fail-open by policy, or
    // CLAMAV_ENABLED=false by deployment choice) — "nothing is being
    // scanned" has no other symptom, so it needs to be visible here rather
    // than only in a boot-time log line or an admin-only page nobody is
    // looking at in the moment it matters.
    {
      name: 'Antivirus',
      ok: (health as any).antivirus === 'ok',
      title:
        (health as any).antivirus === 'disabled'
          ? 'Antivirus scanning is disabled (CLAMAV_ENABLED=false) — uploads are recorded as clean without being scanned.'
          : (health as any).antivirus === 'unreachable'
            ? 'Antivirus is enabled but clamd is unreachable — uploads are allowed through and recorded as unscanned.'
            : undefined,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 rounded-xl bg-surface-raised/50 border border-border">
      <span className="shrink-0 text-xs font-semibold text-text-muted uppercase tracking-wider">
        System
      </span>
      {services.map(({ name, ok, title }) => (
        <span
          key={name}
          title={!ok ? title : undefined}
          className={`flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold ${
            ok ? 'text-emerald-600' : 'text-rose-500'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              ok ? 'bg-emerald-500' : 'bg-rose-500'
            }`}
          />
          {name}
        </span>
      ))}
    </div>
  );
}

// ─── Main dashboard page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const { data: stats, isLoading, isError, refetch } = useDashboardStats();
  const { can } = usePermissions();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const total = stats?.total ?? 0;
  const byStatus = stats?.byStatus ?? {};
  // PENDING_REVIEW + IN_REVIEW = total awaiting approval decision
  const pendingReview =
    (byStatus['PENDING_REVIEW'] ?? 0) + (byStatus['IN_REVIEW'] ?? 0);
  const active = byStatus['ACTIVE'] ?? 0;
  // ARCHIVED is a real document status key returned by the stats API
  const archived = byStatus['ARCHIVED'] ?? 0;

  return (
    <>
      <TopBar
        title="Dashboard"
        breadcrumbs={[{ label: 'Dashboard' }]}
        onMobileMenuToggle={toggleSidebar}
      />

      <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-6">
        {/* ── Error banner ─────────────────────────────────────────────────── */}
        {isError && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />
              <p className="text-sm font-medium text-red-700 dark:text-red-300">
                Could not load dashboard data. Session may have expired.
              </p>
            </div>
            <button
              onClick={() => refetch()}
              className="text-sm font-semibold text-red-600 hover:text-red-800 underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* ── Metric cards ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
            {isLoading ? (
              <SkeletonCard lines={1} />
            ) : (
              <MetricCard
                label="Total Documents"
                value={total.toLocaleString()}
                icon={<FileText className="h-5 w-5" />}
                href="/dashboard/documents"
              />
            )}
          </PermissionGate>

          <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
            {isLoading ? (
              <SkeletonCard lines={1} />
            ) : (
              <MetricCard
                label="Pending Review"
                value={pendingReview}
                icon={<Clock className="h-5 w-5" />}
                toneClassName={pendingReview > 0 ? 'border-amber-200' : ''}
                href="/dashboard/documents?status=PENDING_REVIEW,IN_REVIEW"
              />
            )}
          </PermissionGate>

          <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
            {isLoading ? (
              <SkeletonCard lines={1} />
            ) : (
              <MetricCard
                label="Active"
                value={active.toLocaleString()}
                icon={<CheckCircle2 className="h-5 w-5" />}
                toneClassName="border-emerald-200"
                href="/dashboard/documents?status=ACTIVE"
              />
            )}
          </PermissionGate>

          <PermissionGate permission={PERMISSIONS.DOCUMENT_ARCHIVE}>
            {isLoading ? (
              <SkeletonCard lines={1} />
            ) : (
              <MetricCard
                label="Archived"
                value={archived.toLocaleString()}
                icon={<Archive className="h-5 w-5" />}
                toneClassName="border-slate-200"
                href="/dashboard/documents?status=ARCHIVED"
              />
            )}
          </PermissionGate>
        </div>

        {/* ── Main content grid ────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recent Documents — spans 2/3 on large screens */}
          <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
            <div className="lg:col-span-2 ui-card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-text-primary">
                  Recent Documents
                </h3>
                <Link
                  href="/dashboard/files"
                  className="text-xs text-brand-600 hover:underline font-semibold flex items-center gap-1"
                >
                  View all <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>

              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="ui-skeleton h-10 rounded-lg" />
                  ))}
                </div>
              ) : (stats?.recent ?? []).length === 0 ? (
                <p className="text-sm text-text-muted text-center py-8">
                  No documents yet
                </p>
              ) : (
                <div className="overflow-x-auto ui-scrollbar">
                  <table className="min-w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="pb-2 text-left text-xs font-semibold text-text-muted uppercase">
                          Title
                        </th>
                        <th className="pb-2 text-left text-xs font-semibold text-text-muted uppercase">
                          Status
                        </th>
                        <th className="pb-2 text-left text-xs font-semibold text-text-muted uppercase hidden md:table-cell">
                          Type
                        </th>
                        <th className="pb-2 text-left text-xs font-semibold text-text-muted uppercase">
                          Modified
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(stats?.recent ?? []).slice(0, 8).map((doc) => (
                        <tr key={doc.id} className="ui-table-row">
                          <td className="py-2.5 pr-4">
                            <Link
                              href={`/dashboard/documents/${doc.id}`}
                              className="text-sm font-semibold text-text-primary hover:text-brand-600 truncate block max-w-[200px]"
                            >
                              {doc.title}
                            </Link>
                            <p className="text-[11px] text-text-muted font-mono">
                              {doc.documentName}
                            </p>
                          </td>
                          <td className="py-2.5 pr-4">
                            <StatusBadge status={doc.status} />
                          </td>
                          <td className="py-2.5 pr-4 hidden md:table-cell">
                            <span className="text-xs text-text-secondary">
                              {doc.documentType?.name ?? '—'}
                            </span>
                          </td>
                          <td className="py-2.5">
                            <span className="text-xs text-text-muted whitespace-nowrap">
                              {safeDate(doc.updatedAt, 'MMM d, yyyy')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </PermissionGate>

          {/* Right column: status chart + quick actions */}
          <div className="space-y-4">
            <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
              <div className="ui-card">
                <h3 className="text-sm font-bold text-text-primary mb-4">
                  Document Status
                </h3>
                {isLoading ? (
                  <div className="ui-skeleton h-32 rounded-xl" />
                ) : (
                  <StatusPieChart byStatus={byStatus} />
                )}
              </div>
            </PermissionGate>

            {/* Quick Actions — each link rendered only when can() passes */}
            <div className="ui-card">
              <h3 className="text-sm font-bold text-text-primary mb-3">
                Quick Actions
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {QUICK_ACTIONS.map(
                  ({ label, href, icon: Icon, permission, color }) =>
                    can(permission) ? (
                      <Link
                        key={href}
                        href={href}
                        className={`flex flex-col items-center gap-1.5 p-3 rounded-xl text-center transition-colors ${color}`}
                      >
                        <Icon className="h-5 w-5" />
                        <span className="text-[11px] font-semibold leading-tight">
                          {label}
                        </span>
                      </Link>
                    ) : null,
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Secondary panels ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          <PermissionGate permission={PERMISSIONS.WORKFLOW_APPROVE}>
            <PendingApprovalsPanel />
          </PermissionGate>

          <PermissionGate permission={PERMISSIONS.AUDIT_READ}>
            <AuditPreviewPanel />
          </PermissionGate>

          <PermissionGate permission={PERMISSIONS.LETTER_READ}>
            <LetterVolumeWidget />
          </PermissionGate>

          <PermissionGate permission={PERMISSIONS.OPERATIONS_READ}>
            <div className="ui-card">
              <h3 className="text-sm font-bold text-text-primary mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                System Status
              </h3>
              <SystemHealthStrip />
            </div>
          </PermissionGate>
        </div>
      </div>
    </>
  );
}
