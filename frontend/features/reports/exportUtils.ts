/**
 * Client-side Excel (xlsx) + PDF (jspdf + jspdf-autotable) export for the
 * Reports & Analytics dashboard — mirrors GMS's reports page conceptually
 * (same two libraries, same "workbook of sheets" / "table + header" shape)
 * but written against DMS's own dashboard payload and generic report shape,
 * not copied from GMS.
 *
 * Both entry points here take data already fetched by the page (the
 * dashboard aggregate, or a generic { columns, rows } compliance report) —
 * no network calls happen in this module.
 */
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';

export interface DashboardKpis {
  totalDocuments: number;
  documentsThisPeriod: number;
  documentsPreviousPeriod: number;
  periodChangePercent: number | null;
  pendingApprovals: number;
  pendingSignatures: number;
  retentionEligibleForDisposal?: number;
  documentsOnLegalHold?: number;
  totalStorageUsedBytes?: string;
  storageQuotaUsedPercent?: number;
}

export interface DashboardData {
  range: { from: string; to: string };
  kpis: DashboardKpis;
  trend: { date: string; count: number }[];
  byDepartment: { code: string; name: string; count: number }[];
  byType: { code: string; name: string; count: number }[];
  byClassification: { classification: string; count: number }[];
  byStatus: { status: string; count: number }[];
}

export interface GenericReport {
  key: string;
  name: string;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

function fmtBytes(bytes: string | number | undefined): string {
  if (bytes === undefined) return '—';
  const n = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (Number.isNaN(n) || n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, exp)).toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`;
}

function kpiRows(kpis: DashboardKpis): [string, string | number][] {
  const rows: [string, string | number][] = [
    ['Total Documents', kpis.totalDocuments],
    ['Documents This Period', kpis.documentsThisPeriod],
    ['Documents Previous Period', kpis.documentsPreviousPeriod],
    [
      'Period Change',
      kpis.periodChangePercent === null ? '—' : `${kpis.periodChangePercent > 0 ? '+' : ''}${kpis.periodChangePercent}%`,
    ],
    ['Pending Approvals', kpis.pendingApprovals],
    ['Pending Signatures', kpis.pendingSignatures],
  ];
  if (kpis.retentionEligibleForDisposal !== undefined) {
    rows.push(['Retention-Eligible for Disposal', kpis.retentionEligibleForDisposal]);
  }
  if (kpis.documentsOnLegalHold !== undefined) {
    rows.push(['Documents on Legal Hold', kpis.documentsOnLegalHold]);
  }
  if (kpis.totalStorageUsedBytes !== undefined) {
    rows.push(['Total Storage Used', fmtBytes(kpis.totalStorageUsedBytes)]);
  }
  if (kpis.storageQuotaUsedPercent !== undefined) {
    rows.push(['Storage Quota Used', `${kpis.storageQuotaUsedPercent}%`]);
  }
  return rows;
}

const filenameStamp = (from: string, to: string) => `${from}_to_${to}`;

// ─── Excel ─────────────────────────────────────────────────────────────────

export function exportDashboardToExcel(data: DashboardData) {
  const wb = XLSX.utils.book_new();

  const kpiSheet = XLSX.utils.aoa_to_sheet([
    ['Metric', 'Value'],
    ...kpiRows(data.kpis).map(([label, value]) => [label, value]),
  ]);
  kpiSheet['!cols'] = [{ wch: 32 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, kpiSheet, 'KPIs');

  const trendSheet = XLSX.utils.aoa_to_sheet([
    ['Date', 'Documents Created'],
    ...data.trend.map((r) => [r.date, r.count]),
  ]);
  XLSX.utils.book_append_sheet(wb, trendSheet, 'Trend');

  const deptSheet = XLSX.utils.aoa_to_sheet([
    ['Code', 'Department', 'Documents'],
    ...data.byDepartment.map((r) => [r.code, r.name, r.count]),
  ]);
  XLSX.utils.book_append_sheet(wb, deptSheet, 'By Department');

  const typeSheet = XLSX.utils.aoa_to_sheet([
    ['Code', 'Document Type', 'Documents'],
    ...data.byType.map((r) => [r.code, r.name, r.count]),
  ]);
  XLSX.utils.book_append_sheet(wb, typeSheet, 'By Type');

  const classSheet = XLSX.utils.aoa_to_sheet([
    ['Classification', 'Documents'],
    ...data.byClassification.map((r) => [r.classification, r.count]),
  ]);
  XLSX.utils.book_append_sheet(wb, classSheet, 'By Classification');

  const statusSheet = XLSX.utils.aoa_to_sheet([
    ['Status', 'Documents'],
    ...data.byStatus.map((r) => [r.status, r.count]),
  ]);
  XLSX.utils.book_append_sheet(wb, statusSheet, 'By Status');

  XLSX.writeFile(wb, `dms-reports-dashboard_${filenameStamp(data.range.from, data.range.to)}.xlsx`);
}

export function exportGenericReportToExcel(report: GenericReport) {
  const wb = XLSX.utils.book_new();
  const header = report.columns.map((c) => c.label);
  const body = report.rows.map((row) => report.columns.map((c) => row[c.key] ?? ''));
  const sheet = XLSX.utils.aoa_to_sheet([header, ...body]);
  sheet['!cols'] = report.columns.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, sheet, report.name.slice(0, 31) || 'Report');

  if (Object.keys(report.summary).length > 0) {
    const summarySheet = XLSX.utils.aoa_to_sheet([
      ['Metric', 'Value'],
      ...Object.entries(report.summary).map(([k, v]) => [k, String(v)]),
    ]);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  }

  XLSX.writeFile(wb, `${report.key}.xlsx`);
}

// ─── PDF ───────────────────────────────────────────────────────────────────

function pdfHeader(doc: jsPDF, title: string, subtitle: string) {
  doc.setFontSize(18);
  doc.setTextColor(30);
  doc.text(title, 14, 16);
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(subtitle, 14, 23);
  doc.text(`Generated ${format(new Date(), 'yyyy-MM-dd HH:mm')}`, 14, 28);
}

const AUTOTABLE_STYLE = {
  styles: { fontSize: 9, cellPadding: 2 },
  headStyles: { fillColor: [99, 102, 241] as [number, number, number], textColor: 255, fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: [245, 247, 250] as [number, number, number] },
};

export function exportDashboardToPdf(data: DashboardData) {
  const doc = new jsPDF('p', 'mm', 'a4');
  pdfHeader(doc, 'DMS Reports & Analytics', `Range: ${data.range.from} to ${data.range.to}`);

  autoTable(doc, {
    startY: 34,
    head: [['Metric', 'Value']],
    body: kpiRows(data.kpis).map(([label, value]) => [label, String(value)]),
    ...AUTOTABLE_STYLE,
    margin: { left: 14, right: 14 },
  });

  const afterKpi = (doc as any).lastAutoTable?.finalY ?? 34;
  autoTable(doc, {
    startY: afterKpi + 8,
    head: [['Department', 'Documents']],
    body: data.byDepartment.map((r) => [r.name, String(r.count)]),
    ...AUTOTABLE_STYLE,
    margin: { left: 14, right: 14 },
  });

  const afterDept = (doc as any).lastAutoTable?.finalY ?? afterKpi + 8;
  autoTable(doc, {
    startY: afterDept + 8,
    head: [['Status', 'Documents']],
    body: data.byStatus.map((r) => [r.status, String(r.count)]),
    ...AUTOTABLE_STYLE,
    margin: { left: 14, right: 14 },
  });

  doc.save(`dms-reports-dashboard_${filenameStamp(data.range.from, data.range.to)}.pdf`);
}

export function exportGenericReportToPdf(report: GenericReport) {
  const doc = new jsPDF('l', 'mm', 'a4');
  pdfHeader(doc, report.name, `${report.rows.length} rows`);

  autoTable(doc, {
    startY: 34,
    head: [report.columns.map((c) => c.label)],
    body: report.rows.map((row) => report.columns.map((c) => String(row[c.key] ?? ''))),
    ...AUTOTABLE_STYLE,
    margin: { left: 10, right: 10 },
  });

  doc.save(`${report.key}.pdf`);
}
