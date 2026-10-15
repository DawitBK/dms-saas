'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import {
  FileText,
  ClipboardCheck,
  FileSignature,
  Archive,
  Gavel,
  HardDrive,
  FileSpreadsheet,
  FileDown,
  RefreshCw,
  X,
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Table2,
} from 'lucide-react';
import { apiClient } from '../../../shared/lib/apiClient';
import { TopBar } from '../../../shared/components/TopBar';
import { ErrorState } from '../../../shared/components/ErrorState';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { MetricCard } from '../../../shared/components/ui/MetricCard';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { useDepartments, useDocumentTypes, useOrgUnits } from '../../../shared/hooks/useLookups';
import { useUIStore } from '../../../state/ui.store';
import { ComplianceReportsPanel } from '../../../features/operations/ComplianceReportsPanel';
import { colorForClassification, colorForStatus } from '../../../features/reports/chartColors';
import type { DashboardData } from '../../../features/reports/exportUtils';

// recharts-backed widgets are dynamically imported, ssr:false — keeps recharts
// out of the bundle for every visit that never opens this page (same pattern
// as ComplianceReportChart.tsx / LetterVolumeChart.tsx elsewhere in the app).
const TrendAreaChart = dynamic(
  () => import('../../../features/reports/DashboardCharts').then((m) => m.TrendAreaChart),
  { ssr: false },
);
const DistributionBarChart = dynamic(
  () => import('../../../features/reports/DashboardCharts').then((m) => m.DistributionBarChart),
  { ssr: false },
);
const CategoryDonutChart = dynamic(
  () => import('../../../features/reports/DashboardCharts').then((m) => m.CategoryDonutChart),
  { ssr: false },
);

function fmtBytes(bytes: string | number | undefined): string {
  if (bytes === undefined) return '—';
  const n = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (Number.isNaN(n) || n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, exp)).toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`;
}

const DEFAULT_TO = () => format(new Date(), 'yyyy-MM-dd');
const DEFAULT_FROM = () => format(subDays(new Date(), 29), 'yyyy-MM-dd');

export default function ReportsDashboardPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const [from, setFrom] = useState(DEFAULT_FROM);
  const [to, setTo] = useState(DEFAULT_TO);
  const [orgUnitId, setOrgUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [barDimension, setBarDimension] = useState<'department' | 'type'>('department');
  const [donutDimension, setDonutDimension] = useState<'status' | 'classification'>('status');

  const { data: departments = [] } = useDepartments();
  const { data: orgUnits = [] } = useOrgUnits();
  const { data: documentTypes = [] } = useDocumentTypes();
  const departmentsForOrgUnit = orgUnitId ? departments.filter((d) => d.orgUnitId === orgUnitId) : departments;

  const filtersActive = orgUnitId !== '' || departmentId !== '' || documentTypeId !== '' || from !== DEFAULT_FROM() || to !== DEFAULT_TO();
  const resetFilters = () => {
    setFrom(DEFAULT_FROM());
    setTo(DEFAULT_TO());
    setOrgUnitId('');
    setDepartmentId('');
    setDocumentTypeId('');
  };

  const query = useMemo(() => {
    const params = new URLSearchParams({ from, to });
    if (departmentId) params.set('departmentId', departmentId);
    if (documentTypeId) params.set('documentTypeId', documentTypeId);
    return params.toString();
  }, [from, to, departmentId, documentTypeId]);

  // The reports API answers 403 without document:read_all (tenant-wide analytics), so only ask when the person has it.
  const { can: canRead } = usePermissions();
  const mayRead = canRead(PERMISSIONS.DOCUMENT_READ_ALL);
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    enabled: mayRead,
    queryKey: ['reports-dashboard', from, to, departmentId, documentTypeId],
    queryFn: () => apiClient<{ data: DashboardData }>(`/reports/dashboard?${query}`).then((r) => r.data),
    staleTime: 60_000,
  });

  const kpis = data?.kpis;
  const changeDirection =
    kpis?.periodChangePercent === null || kpis?.periodChangePercent === undefined
      ? 'neutral'
      : kpis.periodChangePercent > 0
        ? 'up'
        : kpis.periodChangePercent < 0
          ? 'down'
          : 'neutral';

  const barData = useMemo(() => {
    const rows = barDimension === 'department' ? data?.byDepartment : data?.byType;
    return (rows ?? []).map((r) => ({ code: r.code, name: r.name, count: r.count }));
  }, [data, barDimension]);

  const donutData = useMemo(() => {
    if (donutDimension === 'status') {
      return (data?.byStatus ?? []).map((r) => ({
        key: r.status,
        label: r.status.replace(/_/g, ' '),
        count: r.count,
      }));
    }
    return (data?.byClassification ?? []).map((r) => ({
      key: r.classification,
      label: r.classification,
      count: r.count,
    }));
  }, [data, donutDimension]);

  const donutColorFor = donutDimension === 'status' ? colorForStatus : colorForClassification;

  return (
    <PermissionGate permission={PERMISSIONS.DOCUMENT_READ_ALL}>
      <>
        <TopBar
          title="Reports & Analytics"
          breadcrumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Reports & Analytics' }]}
          onMobileMenuToggle={toggleSidebar}
        />
        <div className="flex-1 min-h-0 w-full overflow-hidden">
          <div className="mx-auto flex h-full w-full max-w-7xl flex-col p-6">
            <div className="flex items-start justify-between gap-4 mb-6 shrink-0">
              <div className="page-header">
                <h1 className="page-title">Reports & Analytics</h1>
                <p className="page-subtitle">
                  Scoped KPIs, trends, and distribution breakdowns for your active role, plus the full compliance report library.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => refetch()}
                  className="ui-btn ui-btn-ghost ui-btn-icon"
                  aria-label="Refresh"
                  disabled={isFetching}
                >
                  <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => data && import('../../../features/reports/exportUtils').then((m) => m.exportDashboardToExcel(data))}
                  className="ui-btn ui-btn-secondary text-xs"
                  disabled={!data}
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
                </button>
                <button
                  onClick={() => data && import('../../../features/reports/exportUtils').then((m) => m.exportDashboardToPdf(data))}
                  className="ui-btn ui-btn-secondary text-xs"
                  disabled={!data}
                >
                  <FileDown className="h-3.5 w-3.5" /> PDF
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto pr-1 ui-scrollbar space-y-6">
              {/* ── Filter bar ─────────────────────────────────────────────── */}
              <div className="ui-card p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    From
                    <input
                      type="date"
                      value={from}
                      max={to}
                      onChange={(e) => setFrom(e.target.value)}
                      className="ui-input text-sm mt-1 block"
                    />
                  </label>
                  <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    To
                    <input
                      type="date"
                      value={to}
                      min={from}
                      max={DEFAULT_TO()}
                      onChange={(e) => setTo(e.target.value)}
                      className="ui-input text-sm mt-1 block"
                    />
                  </label>
                  <label className="text-xs min-w-[180px]" style={{ color: 'var(--text-muted)' }}>
                    Org Unit
                    <select
                      value={orgUnitId}
                      onChange={(e) => {
                        const value = e.target.value;
                        setOrgUnitId(value);
                        // A department belongs to exactly one org unit --
                        // drop a department filter that no longer belongs to
                        // the newly selected org unit.
                        if (departmentId && value && departments.find((d) => d.id === departmentId)?.orgUnitId !== value) {
                          setDepartmentId('');
                        }
                      }}
                      className="ui-input text-sm mt-1 block"
                    >
                      <option value="">All Org Units</option>
                      {orgUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.code} - {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs min-w-[180px]" style={{ color: 'var(--text-muted)' }}>
                    Department
                    <select
                      value={departmentId}
                      onChange={(e) => setDepartmentId(e.target.value)}
                      className="ui-input text-sm mt-1 block"
                    >
                      <option value="">All Departments</option>
                      {departmentsForOrgUnit.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs min-w-[180px]" style={{ color: 'var(--text-muted)' }}>
                    Document Type
                    <select
                      value={documentTypeId}
                      onChange={(e) => setDocumentTypeId(e.target.value)}
                      className="ui-input text-sm mt-1 block"
                    >
                      <option value="">All Types</option>
                      {documentTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {filtersActive && (
                    <button onClick={resetFilters} className="ui-btn ui-btn-ghost text-xs">
                      <X className="h-3.5 w-3.5" /> Reset
                    </button>
                  )}
                </div>
              </div>

              {isError && (
                <div className="ui-card p-0">
                  <ErrorState error={error} title="Couldn't load the dashboard" onRetry={() => refetch()} />
                </div>
              )}

              {/* ── KPI tiles ──────────────────────────────────────────────── */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => <div key={i} className="ui-skeleton h-28 rounded-2xl" />)
                ) : kpis ? (
                  <>
                    <MetricCard label="Total Documents" value={kpis.totalDocuments.toLocaleString()} icon={<FileText className="h-5 w-5" />} />
                    <MetricCard
                      label="Documents This Period"
                      value={kpis.documentsThisPeriod.toLocaleString()}
                      icon={<BarChart3 className="h-5 w-5" />}
                      trend={
                        kpis.periodChangePercent === null
                          ? undefined
                          : { value: `${Math.abs(kpis.periodChangePercent)}%`, direction: changeDirection }
                      }
                    />
                    <MetricCard label="Pending Approvals" value={kpis.pendingApprovals.toLocaleString()} icon={<ClipboardCheck className="h-5 w-5" />} href="/operations?panel=workflows" />
                    <MetricCard label="Pending Signatures" value={kpis.pendingSignatures.toLocaleString()} icon={<FileSignature className="h-5 w-5" />} href="/dashboard/signing/pending" />
                    {kpis.retentionEligibleForDisposal !== undefined && (
                      <MetricCard
                        label="Retention-Eligible for Disposal"
                        value={kpis.retentionEligibleForDisposal.toLocaleString()}
                        icon={<Archive className="h-5 w-5" />}
                        toneClassName={kpis.retentionEligibleForDisposal > 0 ? 'border-amber-200' : ''}
                        href="/operations?panel=lifecycle"
                      />
                    )}
                    {kpis.documentsOnLegalHold !== undefined && (
                      <MetricCard
                        label="Documents on Legal Hold"
                        value={kpis.documentsOnLegalHold.toLocaleString()}
                        icon={<Gavel className="h-5 w-5" />}
                        toneClassName={kpis.documentsOnLegalHold > 0 ? 'border-red-200' : ''}
                        href="/operations?panel=legalHold"
                      />
                    )}
                    {kpis.totalStorageUsedBytes !== undefined && (
                      <MetricCard
                        label="Storage Used"
                        value={fmtBytes(kpis.totalStorageUsedBytes)}
                        icon={<HardDrive className="h-5 w-5" />}
                        trend={
                          kpis.storageQuotaUsedPercent !== undefined
                            ? { value: `${kpis.storageQuotaUsedPercent}% of quota`, direction: 'neutral' }
                            : undefined
                        }
                        href="/dashboard/storage"
                      />
                    )}
                  </>
                ) : null}
              </div>

              {/* ── Charts ─────────────────────────────────────────────────── */}
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="ui-card p-5 lg:col-span-2">
                  <div className="flex items-center gap-2 mb-4">
                    <LineChartIcon className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Documents Created — Trend
                    </h2>
                  </div>
                  {isLoading ? (
                    <div className="ui-skeleton h-[260px] rounded-xl" />
                  ) : (
                    <TrendAreaChart data={data?.trend ?? []} />
                  )}
                </div>

                <div className="ui-card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <PieChartIcon className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                      <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        By {donutDimension === 'status' ? 'Status' : 'Classification'}
                      </h2>
                    </div>
                    <div className="flex gap-1">
                      {(['status', 'classification'] as const).map((dim) => (
                        <button
                          key={dim}
                          onClick={() => setDonutDimension(dim)}
                          className="text-[11px] px-2 py-1 rounded-md font-medium"
                          style={{
                            background: donutDimension === dim ? 'var(--brand-50)' : 'transparent',
                            color: donutDimension === dim ? 'var(--brand-700)' : 'var(--text-muted)',
                            border: donutDimension === dim ? '1px solid var(--brand-200)' : '1px solid transparent',
                          }}
                        >
                          {dim === 'status' ? 'Status' : 'Class.'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {isLoading ? (
                    <div className="ui-skeleton h-[260px] rounded-xl" />
                  ) : (
                    <CategoryDonutChart data={donutData} colorFor={donutColorFor} />
                  )}
                </div>

                <div className="ui-card p-5 lg:col-span-3">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                      <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        By {barDimension === 'department' ? 'Department' : 'Document Type'}
                      </h2>
                    </div>
                    <div className="flex gap-1">
                      {(['department', 'type'] as const).map((dim) => (
                        <button
                          key={dim}
                          onClick={() => setBarDimension(dim)}
                          className="text-[11px] px-2 py-1 rounded-md font-medium"
                          style={{
                            background: barDimension === dim ? 'var(--brand-50)' : 'transparent',
                            color: barDimension === dim ? 'var(--brand-700)' : 'var(--text-muted)',
                            border: barDimension === dim ? '1px solid var(--brand-200)' : '1px solid transparent',
                          }}
                        >
                          {dim === 'department' ? 'Department' : 'Document Type'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {isLoading ? (
                    <div className="ui-skeleton h-[280px] rounded-xl" />
                  ) : barData.length === 0 ? (
                    <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
                      No documents for the current filters.
                    </p>
                  ) : (
                    <DistributionBarChart data={barData} />
                  )}
                </div>
              </div>

              {/* ── Drill-down: full compliance report library ────────────── */}
              <div className="ui-card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Table2 className="h-5 w-5" style={{ color: 'var(--brand-600)' }} />
                  <div>
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Drill-Down Reports
                    </h2>
                    <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Run any compliance report for a full row-level table, with CSV / Excel / PDF export.
                    </p>
                  </div>
                </div>
                <ComplianceReportsPanel />
              </div>
            </div>
          </div>
        </div>
      </>
    </PermissionGate>
  );
}
