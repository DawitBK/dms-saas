'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { Download, BarChart3, RefreshCw, FileText, FileSpreadsheet, FileDown } from 'lucide-react';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import toast from 'react-hot-toast';
import { apiClient, apiClientBlob } from '../../shared/lib/apiClient';
import { useResetOnChange } from '../../shared/hooks/useResetOnChange';

// recharts is dynamically imported, ssr:false — keeps the chart library out
// of the main operations bundle for visits that never open this panel.
const ComplianceReportChart = dynamic(() => import('./ComplianceReportChart'), { ssr: false });

interface ReportMeta {
  key: string;
  name: string;
  description: string;
  requiredPermission: string;
  hasDateRange: boolean;
}

interface ReportResult {
  key: string;
  name: string;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

interface ChartSeries {
  categoryKey: string;
  series: { key: string; label: string }[];
}

/**
 * Every report follows the same { columns, rows } shape, so the chart is
 * derived generically: the first column is the category axis, and any other
 * column whose values are all numeric becomes a bar series. Reports whose
 * rows are individual records rather than aggregates (e.g. the legal-hold
 * register) simply have no numeric column and fall back to the table only.
 */
function deriveChartSeries(report: ReportResult | undefined): ChartSeries | null {
  if (!report || report.rows.length === 0) return null;
  const [categoryCol, ...restCols] = report.columns;
  if (!categoryCol) return null;
  const numericCols = restCols.filter(
    (c) =>
      report.rows.some((r) => typeof r[c.key] === 'number') &&
      report.rows.every((r) => r[c.key] === null || r[c.key] === undefined || typeof r[c.key] === 'number'),
  );
  if (numericCols.length === 0) return null;
  return {
    categoryKey: categoryCol.key,
    series: numericCols.map((c) => ({ key: c.key, label: c.label })),
  };
}

export function ComplianceReportsPanel() {
  const [selected, setSelected] = useState<ReportMeta | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data: reports = [], isLoading: loadingList } = useQuery({
    queryKey: ['reports-list'],
    queryFn: () => apiClient<{ data: ReportMeta[] }>('/reports').then((r) => r.data),
    staleTime: 300_000,
  });

  const params = new URLSearchParams();
  if (selected?.hasDateRange && from) params.set('from', from);
  if (selected?.hasDateRange && to) params.set('to', to);
  const qs = params.toString();

  const {
    data: report,
    isFetching,
    isError,
    error,
  } = useQuery({
    queryKey: ['report', selected?.key, from, to],
    queryFn: () =>
      apiClient<{ data: ReportResult }>(`/reports/${selected!.key}${qs ? `?${qs}` : ''}`).then((r) => r.data),
    enabled: !!selected,
  });

  const chart = useMemo(() => deriveChartSeries(report), [report]);
  const manyCategories = (report?.rows.length ?? 0) > 5;

  // Client-side pagination of the results table (15/page). The report is fetched
  // whole because the chart, summary, and CSV export all consume the full row
  // set — only the table's rendering is paged, so none of those break.
  const REPORT_PAGE_SIZE = 15;
  const [reportPage, setReportPage] = useState(1);
  useResetOnChange([selected?.key, from, to], () => setReportPage(1));
  const reportTotal = report?.rows.length ?? 0;
  const reportTotalPages = Math.max(1, Math.ceil(reportTotal / REPORT_PAGE_SIZE));
  const pagedRows = report ? report.rows.slice((reportPage - 1) * REPORT_PAGE_SIZE, reportPage * REPORT_PAGE_SIZE) : [];

  const exportExcel = async () => {
    if (!report) return;
    try {
      const { exportGenericReportToExcel } = await import('../reports/exportUtils');
      exportGenericReportToExcel(report);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const exportPdf = async () => {
    if (!report) return;
    try {
      const { exportGenericReportToPdf } = await import('../reports/exportUtils');
      exportGenericReportToPdf(report);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const exportCsv = async () => {
    if (!selected) return;
    try {
      const sep = qs ? '&' : '';
      // CSV is a privileged report response, so use the same authenticated
      // client and refresh/error contract as the report query above.
      const blob = await apiClientBlob(`/reports/${selected.key}?${qs}${sep}format=csv`);
      const href = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href, download: `${selected.key}.csv` }).click();
      URL.revokeObjectURL(href);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    }
  };

  return (
    <div className="flex gap-5">
      {/* Report list */}
      <aside className="w-64 shrink-0">
        <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-muted)' }}>
          Reports
        </p>
        {loadingList ? (
          <div className="py-6 flex justify-center">
            <RefreshCw className="h-4 w-4 animate-spin text-brand-600" />
          </div>
        ) : (
          <nav className="space-y-1">
            {reports.map((r) => (
              <button
                key={r.key}
                onClick={() => setSelected(r)}
                className="w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                style={{
                  color: selected?.key === r.key ? 'var(--brand-700)' : 'var(--text-secondary)',
                  background: selected?.key === r.key ? 'rgba(99,102,241,0.08)' : 'transparent',
                  border: selected?.key === r.key ? '1px solid rgba(99,102,241,0.15)' : '1px solid transparent',
                }}
              >
                {r.name}
              </button>
            ))}
            {reports.length === 0 && (
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                No reports available for your role.
              </p>
            )}
          </nav>
        )}
      </aside>

      {/* Report viewer */}
      <div className="flex-1 min-w-0">
        {!selected ? (
          <div className="ui-empty py-16">
            <div
              className="flex items-center justify-center rounded-xl mb-4"
              style={{ width: 56, height: 56, background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
            >
              <BarChart3 className="h-6 w-6" style={{ color: 'var(--text-muted)' }} />
            </div>
            <p className="ui-empty-title">Select a report</p>
            <p className="ui-empty-desc">Choose a compliance report from the list to run it.</p>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {selected.name}
                </h3>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {selected.description}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={exportCsv} className="ui-btn ui-btn-secondary text-xs" disabled={!report}>
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
                <button onClick={exportExcel} className="ui-btn ui-btn-secondary text-xs" disabled={!report}>
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
                </button>
                <button onClick={exportPdf} className="ui-btn ui-btn-secondary text-xs" disabled={!report}>
                  <FileDown className="h-3.5 w-3.5" /> PDF
                </button>
              </div>
            </div>

            {/* Date range */}
            {selected.hasDateRange && (
              <div className="flex items-end gap-3 mb-4 p-3 rounded-xl" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}>
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  From
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ui-input text-sm mt-1 block" />
                </label>
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  To
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ui-input text-sm mt-1 block" />
                </label>
                {(from || to) && (
                  <button onClick={() => { setFrom(''); setTo(''); }} className="ui-btn ui-btn-ghost text-xs">
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* Summary chips */}
            {report && (
              <div className="flex flex-wrap gap-2 mb-4">
                {Object.entries(report.summary).map(([k, v]) => (
                  <span
                    key={k}
                    className="text-[12px] px-2.5 py-1 rounded-lg font-medium"
                    style={{ background: 'var(--brand-50)', color: 'var(--brand-700)', border: '1px solid var(--brand-200)' }}
                  >
                    {k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}: <strong>{cell(v)}</strong>
                  </span>
                ))}
              </div>
            )}

            {/* Chart — derived generically from the report's numeric columns */}
            {!isFetching && !isError && report && chart && (
              <div
                className="mb-5 p-3 rounded-xl"
                style={{ background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
              >
                <ComplianceReportChart rows={report.rows} chart={chart} manyCategories={manyCategories} />
              </div>
            )}

            {/* Table */}
            {isFetching ? (
              <div className="py-10 flex justify-center">
                <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
              </div>
            ) : isError ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                {(error as Error)?.message ?? 'Failed to run report.'}
              </div>
            ) : report && report.rows.length > 0 ? (
              <div className="overflow-x-auto ui-scrollbar" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
                <table className="ui-table">
                  <thead>
                    <tr>
                      {report.columns.map((c) => (
                        <th key={c.key} className="ui-th">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((row, i) => (
                      <tr key={(reportPage - 1) * REPORT_PAGE_SIZE + i} className="ui-tr">
                        {report.columns.map((c) => (
                          <td key={c.key} className="ui-td">{cell(row[c.key])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reportTotal > REPORT_PAGE_SIZE && (
                  <PaginationControls
                    page={reportPage}
                    onPageChange={setReportPage}
                    hasPrevious={reportPage > 1}
                    hasNext={reportPage * REPORT_PAGE_SIZE < reportTotal}
                    totalPages={reportTotalPages}
                  />
                )}
              </div>
            ) : (
              <div className="ui-empty py-12">
                <div className="flex items-center justify-center rounded-xl mb-4" style={{ width: 56, height: 56, background: 'var(--surface-raised)', border: '1px solid var(--border)' }}>
                  <FileText className="h-6 w-6" style={{ color: 'var(--text-muted)' }} />
                </div>
                <p className="ui-empty-title">No data</p>
                <p className="ui-empty-desc">This report returned no rows for the current scope.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
