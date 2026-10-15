'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../../shared/lib/apiClient';
import { TopBar } from '../../../shared/components/TopBar';
import { ErrorState } from '../../../shared/components/ErrorState';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { useUIStore } from '../../../state/ui.store';
import { Database, HardDrive, FileText, AlertTriangle, CheckCircle2, BarChart3 } from 'lucide-react';

const PAGE_SIZE = 10;

/** Client-side pagination over a small, already-fully-fetched analytics
 * array (the backend returns the whole aggregate in one call — there's no
 * server-side page/limit for these report endpoints). */
function usePagedList<T>(items: T[]) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [items, safePage],
  );
  return {
    page: safePage,
    setPage,
    pageItems,
    totalPages,
    hasPrevious: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

function fmtBytes(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (isNaN(n) || n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, exp)).toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`;
}

function QuotaBar({ percent }: { percent: number }) {
  const color = percent >= 90 ? '#ef4444' : percent >= 80 ? '#f97316' : '#22c55e';
  return (
    <div className="relative h-3 rounded-full overflow-hidden" style={{ background: 'var(--surface-raised)' }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(percent, 100)}%`, background: color }}
      />
    </div>
  );
}

export default function StorageAnalyticsPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const { can: canRead } = usePermissions();
  const { data, isLoading, isError, error, refetch } = useQuery({
    enabled: canRead(PERMISSIONS.DOCUMENT_READ_ALL),
    queryKey: ['storage-analytics'],
    queryFn: () => apiClient<{ data: any }>('/reports/storage/analytics'),
    staleTime: 5 * 60_000,
  });

  const analytics = data?.data;

  const departmentsWithUsage = useMemo(
    () => (analytics?.byDepartment ?? []).filter((d: any) => parseInt(d.totalBytes) > 0),
    [analytics],
  );
  const documentTypesWithUsage = useMemo(
    () => (analytics?.byDocumentType ?? []).filter((d: any) => parseInt(d.totalBytes) > 0),
    [analytics],
  );

  const deptPaging = usePagedList(departmentsWithUsage);
  const docTypePaging = usePagedList(documentTypesWithUsage);
  // "Documents by Status" is a small, fixed enum (DRAFT/ACTIVE/ARCHIVED/etc,
  // ~6-8 possible statuses) — it never realistically grows past a page, so
  // it's rendered in full without pagination.

  return (
    <PermissionGate permission={PERMISSIONS.DOCUMENT_READ_ALL}>
      <>
        <TopBar
          title="Storage Analytics"
          breadcrumbs={[
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Storage Analytics' },
          ]}
          onMobileMenuToggle={toggleSidebar}
        />
        <div className="flex-1 min-h-0 w-full overflow-hidden">
          <div className="mx-auto flex h-full w-full max-w-7xl flex-col p-6">
            <div className="page-header mb-6 shrink-0">
              <h1 className="page-title">Storage Analytics</h1>
              <p className="page-subtitle">Per-tenant storage breakdown, quota tracking, and usage alerts</p>
            </div>

            {/* Keep the page title in place; analytics content gets its own
                bounded scroll area instead of scrolling the whole dashboard. */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 ui-scrollbar">

              {isLoading && (
                <div className="grid gap-4 sm:grid-cols-3 mb-6">
                  {[1, 2, 3].map((i) => <div key={i} className="skeleton h-28 rounded-2xl" />)}
                </div>
              )}

              {isError && (
                <div className="ui-card p-0 mb-6">
                  <ErrorState error={error} title="Couldn't load storage analytics" onRetry={() => refetch()} />
                </div>
              )}

          {analytics && (
            <>
              {/* Summary Cards */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
                <div className="ui-card p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(99,102,241,0.1)' }}>
                      <HardDrive className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Total Used</span>
                  </div>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {fmtBytes(analytics.summary.totalStorageUsed)}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    of {fmtBytes(analytics.summary.quotaBytes)} quota
                  </p>
                </div>

                <div className="ui-card p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.1)' }}>
                      <FileText className="h-5 w-5 text-emerald-500" />
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Documents</span>
                  </div>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {analytics.summary.totalDocuments.toLocaleString()}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>across all departments</p>
                </div>

                <div className="ui-card p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(249,115,22,0.1)' }}>
                      <Database className="h-5 w-5 text-orange-500" />
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Quota Used</span>
                  </div>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {analytics.summary.quotaUsedPercent}%
                  </p>
                  <div className="mt-2">
                    <QuotaBar percent={analytics.summary.quotaUsedPercent} />
                  </div>
                </div>

                <div className="ui-card p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }}>
                      <AlertTriangle className="h-5 w-5 text-red-500" />
                    </div>
                    <span className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>Alerts</span>
                  </div>
                  {analytics.summary.alerts.filter((a: any) => a.reached).length === 0 ? (
                    <div className="flex items-center gap-2 text-emerald-500">
                      <CheckCircle2 className="h-5 w-5" />
                      <span className="text-sm font-semibold">No alerts</span>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {analytics.summary.alerts.filter((a: any) => a.reached).map((a: any) => (
                        <p key={a.threshold} className="text-xs text-red-500 font-medium">
                          ⚠ {a.threshold}% threshold reached
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {/* By Department */}
                <div className="ui-card p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <BarChart3 className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Usage by Department
                    </h2>
                  </div>
                  <div className="space-y-3">
                    {deptPaging.pageItems.map((dept: any) => {
                      const pct = analytics.summary.quotaBytes !== '0'
                        ? Math.min(100, Math.round((parseInt(dept.totalBytes) / parseInt(analytics.summary.totalStorageUsed || '1')) * 100))
                        : 0;
                      return (
                        <div key={dept.departmentId ?? `${dept.departmentCode}-${dept.departmentName}`}>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {dept.departmentName}
                            </span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {fmtBytes(dept.totalBytes)} · {dept.documentCount} docs
                            </span>
                          </div>
                          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-raised)' }}>
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${pct}%`, background: 'var(--brand-600)' }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {departmentsWithUsage.length === 0 && (
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No usage data yet.</p>
                    )}
                  </div>
                  {departmentsWithUsage.length > PAGE_SIZE && (
                    <PaginationControls
                      page={deptPaging.page}
                      onPageChange={deptPaging.setPage}
                      hasPrevious={deptPaging.hasPrevious}
                      hasNext={deptPaging.hasNext}
                      totalPages={deptPaging.totalPages}
                    />
                  )}
                </div>

                {/* By Status */}
                <div className="ui-card p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <BarChart3 className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Documents by Status
                    </h2>
                  </div>
                  <div className="space-y-2">
                    {analytics.byStatus.map((s: any) => (
                      <div key={s.status} className="flex items-center justify-between py-1 border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.status}</span>
                        <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                          <span>{s.documentCount.toLocaleString()} docs</span>
                          <span>{fmtBytes(s.totalBytes)}</span>
                        </div>
                      </div>
                    ))}
                    {analytics.byStatus.length === 0 && (
                      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No documents found.</p>
                    )}
                  </div>
                </div>

                {/* By Document Type */}
                <div className="ui-card p-5 lg:col-span-2">
                  <div className="flex items-center gap-2 mb-4">
                    <FileText className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Usage by Document Type
                    </h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th className="text-left pb-2 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Type</th>
                          <th className="text-right pb-2 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Documents</th>
                          <th className="text-right pb-2 text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Total Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {docTypePaging.pageItems.map((dt: any) => (
                          <tr key={dt.documentTypeCode} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td className="py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{dt.documentTypeName}</td>
                            <td className="py-2 text-right" style={{ color: 'var(--text-muted)' }}>{dt.documentCount.toLocaleString()}</td>
                            <td className="py-2 text-right" style={{ color: 'var(--text-muted)' }}>{fmtBytes(dt.totalBytes)}</td>
                          </tr>
                        ))}
                        {documentTypesWithUsage.length === 0 && (
                          <tr>
                            <td colSpan={3} className="py-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No data</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {documentTypesWithUsage.length > PAGE_SIZE && (
                    <PaginationControls
                      page={docTypePaging.page}
                      onPageChange={docTypePaging.setPage}
                      hasPrevious={docTypePaging.hasPrevious}
                      hasNext={docTypePaging.hasNext}
                      totalPages={docTypePaging.totalPages}
                    />
                  )}
                </div>
              </div>
            </>
              )}
            </div>
          </div>
        </div>
      </>
    </PermissionGate>
  );
}
