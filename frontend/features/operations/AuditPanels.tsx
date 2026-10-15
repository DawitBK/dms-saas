'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuditLogs, useAuditLogsPage } from '../documents/hooks';
import { listAuditLogs } from '../documents/api';
import { apiClient, apiClientBlob } from '../../shared/lib/apiClient';
import { format } from 'date-fns';
import {
  ShieldCheck,
  ShieldAlert,
  Search,
  Download,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Hash,
  FileSearch,
  FileText,
  FileJson,
  FileSpreadsheet,
} from 'lucide-react';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import { Modal } from '../../shared/components/Modal';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../shared/lib/permissions';

type ChainBreak = {
  sequenceNumber: string;
  kind: 'hash' | 'ordering' | 'linkage';
  message: string;
  acknowledged?: { by: string; at: string; reason: string };
};

type IntegrityResult = {
  valid: boolean;
  brokenAtSequence: string | null;
  message?: string;
  totalVerified?: number;
  breaks?: ChainBreak[];
  /** Breaks a recorded acknowledgement explains; `valid` ignores them but they stay listed. */
  acknowledgedBreaks?: number;
} | null;

const BREAK_KIND_LABEL: Record<ChainBreak['kind'], string> = {
  hash: 'the entry itself no longer matches its fingerprint',
  ordering: 'entries out of order',
  linkage: 'an entry does not link to the one before it',
};

type ExportFormat = 'csv' | 'json' | 'pdf';

const EXPORT_FORMAT_ICON: Record<ExportFormat, typeof FileSpreadsheet> = {
  csv: FileSpreadsheet,
  json: FileJson,
  pdf: FileText,
};

// 15/page, matching the project-wide pagination convention (see
// documents.routes.ts skip/take + shared/components/ui/PaginationControls.tsx).
const AUDIT_PAGE_SIZE = 15;

export function AuditLogPanel() {
  const [searchQuery, setSearchQuery] = useState('');
  const [eventFilter, setEventFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exporting, setExporting] = useState(false);

  // Search/event-type filters are sent as query params (see audit.routes.ts)
  // so they're applied server-side and compose with pagination, instead of
  // only matching whichever 15-row page happens to already be loaded.
  const { data: pageData, isLoading, refetch } = useAuditLogsPage({
    eventType: eventFilter === 'ALL' ? undefined : eventFilter,
    q: searchQuery.trim() || undefined,
    skip: (page - 1) * AUDIT_PAGE_SIZE,
    take: AUDIT_PAGE_SIZE,
  });
  const filteredLogs = pageData?.data as any[] | undefined;
  const total = pageData?.total ?? filteredLogs?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  const updateSearch = (v: string) => { setSearchQuery(v); setPage(1); };
  const updateEventFilter = (v: string) => { setEventFilter(v); setPage(1); };

  // Dropdown options: a lightweight, separately-fetched sample of event types
  // (not the current 15-row page, which won't have every type on it) — same
  // "dropdown picker, not a paged list" pattern ApprovalChainsPanel uses for
  // its form-template picker.
  const { data: eventTypesSample } = useQuery({
    queryKey: ['audit-event-types-sample'],
    // 100 is the route's own max take (audit.routes.ts) — the largest sample
    // a single request can pull.
    queryFn: () => listAuditLogs({ take: 100 }).then((r) => r.data as any[]),
    staleTime: 300_000,
  });
  const uniqueEventTypes = Array.from(
    new Set((eventTypesSample ?? []).map((l: any) => l.eventType)),
  );

  // Backend-powered export (GET /audit/export) — supports CSV/JSON/PDF, a real
  // date range, and up to 10,000 rows, unlike the visible table which is
  // capped at the latest 100 events. Previously the UI only offered a
  // client-side CSV built from those same 100 rows, so PDF export and any
  // export beyond the last 100 events were unreachable from the frontend.
  const runExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ format: exportFormat, limit: '10000' });
      if (eventFilter !== 'ALL') params.set('eventType', eventFilter);
      if (exportFrom) params.set('from', exportFrom);
      if (exportTo) params.set('to', exportTo);

      // Keep exports on the shared client: it supplies the current token,
      // performs the one-time refresh/retry, and turns non-2xx responses into
      // the same structured ApiError every other authenticated action gets.
      const blob = await apiClientBlob(`/audit/export?${params.toString()}`);
      const href = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href,
        download: `audit-export-${Date.now()}.${exportFormat}`,
      }).click();
      URL.revokeObjectURL(href);
      toast.success('Export downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-col md:flex-row gap-3 justify-between">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
          <input
            type="text"
            placeholder="Search by event type, user ID, or document ID..."
            value={searchQuery}
            onChange={(e) => updateSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-sm border border-border rounded-xl bg-surface-card focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={eventFilter}
            onChange={(e) => updateEventFilter(e.target.value)}
            className="px-3 py-2.5 text-sm border border-border rounded-xl bg-surface-card focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            <option value="ALL">All Event Types</option>
            {uniqueEventTypes.map((et) => (
              <option key={et as string} value={et as string}>
                {et as string}
              </option>
            ))}
          </select>
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-text-primary bg-surface-card hover:bg-surface-hover rounded-xl border border-border shadow-sm transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setExportOpen((o) => !o)}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-text-primary bg-surface-card hover:bg-surface-hover rounded-xl border border-border shadow-sm transition-colors"
          >
            <Download className="h-4 w-4" /> Export
          </button>
        </div>
      </div>

      {exportOpen && (
        <div className="flex flex-wrap items-end gap-3 p-4 rounded-xl border border-border bg-surface-hover">
          <div>
            <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Format</label>
            <div className="flex gap-1.5">
              {(['csv', 'json', 'pdf'] as ExportFormat[]).map((fmt) => {
                const Icon = EXPORT_FORMAT_ICON[fmt];
                return (
                  <button
                    key={fmt}
                    onClick={() => setExportFormat(fmt)}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase rounded-lg border transition-colors ${
                      exportFormat === fmt
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-surface-card text-text-secondary border-border hover:bg-surface-raised'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {fmt}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">From</label>
            <input
              type="date"
              value={exportFrom}
              onChange={(e) => setExportFrom(e.target.value)}
              className="px-3 py-2 text-sm border border-border rounded-lg bg-surface-card"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">To</label>
            <input
              type="date"
              value={exportTo}
              onChange={(e) => setExportTo(e.target.value)}
              className="px-3 py-2 text-sm border border-border rounded-lg bg-surface-card"
            />
          </div>
          <button
            onClick={runExport}
            disabled={exporting}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm transition-colors disabled:opacity-60"
          >
            <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : `Download ${exportFormat.toUpperCase()}`}
          </button>
          <p className="w-full text-xs text-text-muted">
            Exports up to 10,000 events matching the current event-type filter and date range — not just the current page shown below.
          </p>
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface-card rounded-xl shadow-sm ring-1 ring-border p-4">
          <p className="text-2xl font-bold text-text-primary">
            {total}
          </p>
          <p className="text-xs text-text-muted font-semibold uppercase tracking-wide mt-1">
            Total Events{searchQuery.trim() || eventFilter !== 'ALL' ? ' (matching filter)' : ''}
          </p>
        </div>
        <div className="bg-surface-card rounded-xl shadow-sm ring-1 ring-border p-4">
          <p className="text-2xl font-bold text-text-primary">{uniqueEventTypes.length}</p>
          <p className="text-xs text-text-muted font-semibold uppercase tracking-wide mt-1">
            Unique Event Types
          </p>
        </div>
      </div>

      {/* Log Table */}
      {isLoading ? (
        <div className="p-12 text-center">
          <RefreshCw className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-3" />
          <p className="text-text-muted text-sm">Loading audit trail...</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border-subtle rounded-xl">
          <table className="min-w-full divide-y divide-border-subtle">
            <thead className="bg-surface-hover">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                  #
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                  Timestamp
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                  Event
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                  User
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                  Document
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                  Entry Hash
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {filteredLogs?.map((log: any) => (
                <tr key={log.id} className="hover:bg-surface-hover transition-colors">
                  <td className="px-6 py-3 text-xs font-mono text-text-muted">
                    {log.sequenceNumber}
                  </td>
                  <td className="px-6 py-3 text-xs text-text-secondary whitespace-nowrap">
                    {format(new Date(log.timestamp), 'MMM d, HH:mm:ss')}
                  </td>
                  <td className="px-6 py-3">
                    <span className="inline-block bg-indigo-50 text-indigo-700 border border-indigo-100 text-xs font-bold px-2 py-0.5 rounded">
                      {log.eventType}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-xs font-mono text-text-primary truncate max-w-[100px]">
                    {log.userId ?? 'System'}
                  </td>
                  <td className="px-6 py-3 text-xs font-mono text-text-secondary truncate max-w-[120px]">
                    {log.documentId ?? '—'}
                  </td>
                  <td className="px-6 py-3">
                    <code
                      className="text-[10px] bg-surface-raised px-2 py-1 rounded font-mono text-text-muted block max-w-[160px] truncate"
                      title={log.entryHash}
                    >
                      {log.entryHash ?? '—'}
                    </code>
                  </td>
                </tr>
              ))}
              {filteredLogs?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-text-muted text-sm">
                    No events match your filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {total > AUDIT_PAGE_SIZE && (
        <PaginationControls
          page={page}
          onPageChange={setPage}
          hasPrevious={page > 1}
          hasNext={page * AUDIT_PAGE_SIZE < total}
          totalPages={totalPages}
          isLoading={isLoading}
        />
      )}
    </div>
  );
}

export function IntegrityVerificationPanel() {
  const { data: auditLogs } = useAuditLogs();
  const [integrityResult, setIntegrityResult] = useState<IntegrityResult>(null);
  const [verifying, setVerifying] = useState(false);
  const { can } = usePermissions();
  const canAcknowledge = can(PERMISSIONS.OPERATIONS_MANAGE);
  const [ackTarget, setAckTarget] = useState<ChainBreak | null>(null);
  const [ackReason, setAckReason] = useState('');
  const [acknowledging, setAcknowledging] = useState(false);

  // Records that a reported break is known, explained and historical. Nothing is rewritten: the break stays listed.
  const acknowledgeBreak = async () => {
    if (!ackTarget) return;
    setAcknowledging(true);
    try {
      const result = await apiClient<IntegrityResult>('/audit/chain-acknowledgements', {
        method: 'POST',
        body: JSON.stringify({ sequenceNumber: ackTarget.sequenceNumber, kind: ackTarget.kind, reason: ackReason.trim() }),
      });
      setIntegrityResult(result);
      setAckTarget(null);
      setAckReason('');
      toast.success('Break acknowledged — it stays on record and is listed below');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not acknowledge the break');
    } finally {
      setAcknowledging(false);
    }
  };

  const verifyIntegrity = async () => {
    setVerifying(true);
    try {
      const result = await apiClient<IntegrityResult>('/audit/verify-integrity');
      setIntegrityResult(result);
    } catch {
      setIntegrityResult({ valid: false, brokenAtSequence: 'UNKNOWN' });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Status Card */}
      <div
        className={`rounded-xl shadow-sm ring-1 p-6 ${integrityResult === null ? 'bg-surface-hover ring-border' : integrityResult.valid && (integrityResult.acknowledgedBreaks ?? 0) > 0 ? 'bg-amber-50 ring-amber-200' : integrityResult.valid ? 'bg-green-50 ring-green-200' : 'bg-red-50 ring-red-200'}`}
      >
        <div className="flex items-center gap-4">
          {integrityResult === null ? (
            <FileSearch className="h-12 w-12 text-text-muted" />
          ) : integrityResult.valid ? (
            <ShieldCheck className="h-12 w-12 text-green-600" />
          ) : (
            <ShieldAlert className="h-12 w-12 text-red-600" />
          )}
          <div className="flex-1">
            <p className="text-lg font-bold text-text-primary">
              {integrityResult === null
                ? 'Not Verified'
                : integrityResult.valid
                  ? (integrityResult.acknowledgedBreaks ?? 0) > 0 ? 'Chain valid, with acknowledged historical break(s)' : 'Chain Valid ✓'
                  : 'Chain Broken ⚠'}
            </p>
            <p className="text-sm text-text-muted mt-1">
              {integrityResult === null
                ? 'Click verify to check audit log integrity'
                : integrityResult.valid
                  ? (integrityResult.acknowledgedBreaks ?? 0) > 0
                    ? (integrityResult.message ?? 'Historical break(s) are acknowledged; nothing unexplained.')
                    : `All ${integrityResult.totalVerified ?? (auditLogs as any[])?.length ?? 0} entries verified — no tampering detected`
                  : (integrityResult.message ?? `Chain broken at sequence #${integrityResult.brokenAtSequence}. The audit log may have been tampered with.`)}
            </p>
          </div>
        </div>
      </div>

      {/* Verify Button */}
      <button
        onClick={verifyIntegrity}
        disabled={verifying}
        className="w-full inline-flex items-center justify-center gap-2 px-6 py-4 text-base font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md shadow-indigo-100 transition-all disabled:opacity-60"
      >
        <Hash className="h-5 w-5" />
        {verifying ? 'Verifying Chain...' : 'Verify Chain Integrity'}
      </button>

      {/* Info */}
      {integrityResult !== null && (
        <div
          className={`p-5 rounded-xl border ${
            integrityResult.valid
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          {integrityResult.valid ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-base text-green-800">
                  Chain Integrity Verified
                </p>
                <p className="text-sm text-green-700 mt-1">
                  The entire audit log hash chain is valid. No entries have been tampered with.
                  This provides cryptographic proof of data integrity.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-base text-red-800">
                  Chain Integrity Violation Detected
                </p>
                <p className="text-sm text-red-700 mt-1">
                  {integrityResult.message ?? `Chain broken at sequence #${integrityResult.brokenAtSequence}.`} This
                  indicates potential tampering with the audit log. Immediate investigation
                  required.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {integrityResult !== null && (integrityResult.breaks ?? []).length > 0 && (
        <div className="rounded-xl border border-border bg-surface-card p-5" data-testid="chain-breaks">
          <p className="text-sm font-bold text-text-primary mb-1">Breaks found</p>
          <p className="text-xs text-text-muted mb-3">
            A break is never hidden or rewritten. If it is known and explained (for example a row left over from a long-fixed fault),
            an administrator can acknowledge it: the verification then stops counting it as unexplained, but it stays on this list with
            who acknowledged it and why. If the entry is changed again afterwards, the acknowledgement no longer applies.
          </p>
          <ul className="space-y-2">
            {(integrityResult.breaks ?? []).map((b) => (
              <li key={`${b.sequenceNumber}-${b.kind}`} className="flex flex-wrap items-start gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                <span className="font-mono text-xs font-bold">#{b.sequenceNumber}</span>
                <span className="text-xs text-text-secondary flex-1 min-w-[12rem]">{BREAK_KIND_LABEL[b.kind]}</span>
                {b.acknowledged ? (
                  <span className="text-xs rounded px-2 py-0.5 bg-amber-100 text-amber-800" title={b.acknowledged.reason}>
                    Acknowledged {format(new Date(b.acknowledged.at), 'PP')} — {b.acknowledged.reason}
                  </span>
                ) : canAcknowledge ? (
                  <button onClick={() => { setAckTarget(b); setAckReason(''); }} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px]">
                    Acknowledge…
                  </button>
                ) : (
                  <span className="text-xs text-red-700 font-semibold">Unexplained</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal isOpen={ackTarget !== null} onClose={() => setAckTarget(null)} title={`Acknowledge break at #${ackTarget?.sequenceNumber ?? ''}`}>
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            You are recording that this break is <strong>known and explained</strong>. It does not repair anything and it is not hidden: it
            stays listed, and this acknowledgement is itself written to the audit log. Only do this when you know why it is there.
          </p>
          <textarea
            className="ui-input w-full"
            rows={3}
            placeholder="Why is this break known and harmless? (at least 20 characters)"
            value={ackReason}
            onChange={(e) => setAckReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAckTarget(null)} className="ui-btn ui-btn-secondary">Back</button>
            <button onClick={acknowledgeBreak} disabled={acknowledging || ackReason.trim().length < 20} className="ui-btn ui-btn-primary">
              {acknowledging ? 'Working…' : 'Acknowledge break'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
