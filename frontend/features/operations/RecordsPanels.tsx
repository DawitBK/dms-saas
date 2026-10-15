'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useDocuments } from '../documents/hooks';
import { listDocuments } from '../documents/api';
import { apiClient } from '../../shared/lib/apiClient';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PaginationControls } from '../../shared/components/ui/PaginationControls';
import Link from 'next/link';
import { format } from 'date-fns';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { PermissionGate } from '../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { ErrorState } from '../../shared/components/ErrorState';
import { getErrorMessage } from '../../shared/lib/errorMessage';
import {
  Archive,
  Lock,
  Clock,
  FileStack,
  RefreshCw,
  CheckCircle2,
  Cpu,
  Eye,
} from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  ACTIVE: 'bg-green-100 text-green-700',
  ARCHIVED: 'bg-blue-100 text-blue-700',
  DISPOSAL_PENDING: 'bg-orange-100 text-orange-700',
  DISPOSED: 'bg-red-100 text-red-700',
  UNDER_REVIEW: 'bg-yellow-100 text-yellow-700',
};

// FIX (platform audit finding 2026-08-14, follow-up): this used to gate on
// ['ACTIVE', 'UNDER_REVIEW'] — 'UNDER_REVIEW' doesn't exist in
// DocumentStateMachine.ts's real states (leftover from a pre-rename naming
// scheme, so it never matched anything), while APPROVED/SIGNED/AUDITED/
// SUPERSEDED — all real, common ->ARCHIVED sources per that file's
// MANUAL_TRANSITION_PERMISSIONS map — were missing entirely. A records
// officer opening this exact console (its primary use case) saw no Archive
// action at all for most archivable documents. Keep this list in sync with
// every "X->ARCHIVED": "document:archive" key in DocumentStateMachine.ts.
const ARCHIVABLE_FROM = ['ACTIVE', 'APPROVED', 'SIGNED', 'AUDITED', 'SUPERSEDED'];

function ArchiveButton({ docId, status }: { docId: string; status: string }) {
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();
  if (!ARCHIVABLE_FROM.includes(status)) return null;
  const handleArchive = async () => {
    setLoading(true);
    try {
      await apiClient(`/documents/${docId}/archive`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['documents'] });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Archive failed'));
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      onClick={handleArchive}
      disabled={loading}
      className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
    >
      <Archive className="h-3.5 w-3.5" /> {loading ? 'Archiving...' : 'Archive'}
    </button>
  );
}

const RECORDS_PAGE_SIZE = 15;

export function RecordsLifecyclePanel() {
  // The stat cards are aggregate summaries over the tenant's documents; they
  // stay on the shared top-50 feed (approximate, as before — not a growing list
  // display). The table below is what gets real server-side pagination.
  const { data: documents, isError, error: documentsErrorObj, refetch: refetchDocuments } = useDocuments();
  const [activeTab, setActiveTab] = useState<'lifecycle' | 'retention' | 'ocr'>(
    'lifecycle',
  );
  const [page, setPage] = useState(1);

  const byStatus = (s: string) =>
    documents?.filter((d: any) => d.status === s)?.length ?? 0;
  const onHold = documents?.filter((d: any) => d.isOnLegalHold)?.length ?? 0;
  const lowOcr =
    documents?.filter((d: any) => d.ocrStatus === 'LOW_CONFIDENCE')?.length ??
    0;
  const loadError = isError;

  const changeTab = (key: 'lifecycle' | 'retention' | 'ocr') => {
    setActiveTab(key);
    setPage(1);
  };

  // Per-tab server-side paged query (15/page). Filters map to the backend list
  // filters: retention → retentionRelevant (status DISPOSAL_PENDING OR a
  // retention class), ocr → ocrStatus=LOW_CONFIDENCE, lifecycle → all.
  const tableFilters =
    activeTab === 'ocr'
      ? { ocrStatus: 'LOW_CONFIDENCE' }
      : activeTab === 'retention'
        ? { retentionRelevant: true }
        : {};
  const { data: tablePage, isLoading, isError: tableError, error: tableErrorObj, refetch: refetchTable } = useQuery({
    queryKey: ['records-lifecycle', activeTab, page],
    queryFn: () => listDocuments((page - 1) * RECORDS_PAGE_SIZE, RECORDS_PAGE_SIZE, tableFilters),
    staleTime: 30_000,
  });
  const rows = tablePage?.data ?? [];
  const total = tablePage?.total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / RECORDS_PAGE_SIZE));

  const tabs = [
    { key: 'lifecycle' as const, label: 'Lifecycle Queue', icon: FileStack },
    { key: 'retention' as const, label: 'Retention', icon: Clock },
    { key: 'ocr' as const, label: 'OCR Review', icon: Cpu },
  ];

  return (
    <>
      <div className="mb-8">
        <h2 className="text-xl font-bold text-text-primary">
          Records Officer Console
        </h2>
        <p className="text-text-muted mt-1">
          Full document lifecycle governance, retention, and disposal
          management.
        </p>
      </div>

      {/* Stats Row */}
      {loadError && (
        <div className="ui-card mb-6 p-0">
          <ErrorState error={documentsErrorObj} title="Couldn't load records data" onRetry={() => refetchDocuments()} />
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        {[
          {
            label: 'Active',
            value: loadError ? 'Error' : byStatus('ACTIVE'),
            color: 'text-green-700 bg-green-50 border-green-200',
            href: '/dashboard/documents?status=ACTIVE',
          },
          {
            label: 'Archived',
            value: loadError ? 'Error' : byStatus('ARCHIVED'),
            color: 'text-blue-700 bg-blue-50 border-blue-200',
            href: '/dashboard/documents?status=ARCHIVED',
          },
          {
            label: 'Disposal Pending',
            value: loadError ? 'Error' : byStatus('DISPOSAL_PENDING'),
            color: 'text-orange-700 bg-orange-50 border-orange-200',
            href: '/dashboard/documents?status=DISPOSAL_PENDING',
          },
          {
            label: 'Legal Hold',
            value: loadError ? 'Error' : onHold,
            color: 'text-red-700 bg-red-50 border-red-200',
            href: '/operations?panel=legalHold',
          },
          {
            label: 'OCR Low Confidence',
            value: loadError ? 'Error' : lowOcr,
            color: 'text-purple-700 bg-purple-50 border-purple-200',
            href: '/operations?panel=ocr',
          },
        ].map(({ label, value, color, href }) => (
          <Link key={label} href={href} className={`block rounded-xl border p-4 transition-shadow hover:shadow-md ${color}`}>
            <p className="text-2xl font-black">{value}</p>
            <p className="text-xs font-bold uppercase tracking-wide mt-1 opacity-75">
              {label}
            </p>
          </Link>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface-hover rounded-xl mb-6 w-fit">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => changeTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              activeTab === key
                ? 'bg-surface-card shadow-sm text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div className="bg-surface-card shadow-sm ring-1 ring-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="p-16 text-center">
            <RefreshCw className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-4" />
            <p className="text-text-muted">Loading records...</p>
          </div>
        ) : tableError ? (
          <ErrorState error={tableErrorObj} title="Couldn't load this tab's records" onRetry={() => refetchTable()} />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border-subtle">
              <thead className="bg-surface-hover">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Document
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Retention
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Flags
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((doc: any) => (
                  <tr
                    key={doc.id}
                    className="hover:bg-surface-hover/80 transition-colors group"
                  >
                    <td className="px-6 py-4">
                      <p className="text-sm font-semibold text-text-primary truncate max-w-xs">
                        {doc.title}
                      </p>
                      <p className="text-xs text-text-muted font-mono">
                        {doc.documentName}
                      </p>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_COLORS[doc.status] ?? 'bg-slate-100 text-slate-600'}`}
                      >
                        {doc.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-text-muted">
                      {doc.retentionClass}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-1.5">
                        {doc.isOnLegalHold && (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                            <Lock className="h-2.5 w-2.5" /> HOLD
                          </span>
                        )}
                        {doc.ocrStatus === 'LOW_CONFIDENCE' && (
                          <span className="inline-flex items-center gap-1 text-xs font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-200">
                            <Cpu className="h-2.5 w-2.5" /> OCR
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs text-text-muted">
                      {format(new Date(doc.createdAt), 'MMM d, yyyy')}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Link
                          href={`/dashboard/documents/${doc.id}`}
                          className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800"
                        >
                          <Eye className="h-3.5 w-3.5" /> View
                        </Link>
                        <PermissionGate permission={PERMISSIONS.DOCUMENT_ARCHIVE}>
                          <ArchiveButton docId={doc.id} status={doc.status} />
                        </PermissionGate>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-12 text-center text-text-muted text-sm"
                    >
                      No records found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {total > RECORDS_PAGE_SIZE && (
          <div className="border-t border-border-subtle px-4">
            <PaginationControls
              page={page}
              onPageChange={setPage}
              hasPrevious={page > 1}
              hasNext={page * RECORDS_PAGE_SIZE < total}
              totalPages={totalPages}
              isLoading={isLoading}
            />
          </div>
        )}
      </div>
    </>
  );
}

export function OcrReviewPanel() {
  const [page, setPage] = useState(1);
  // Server-side paged query (15/page) filtered to low-confidence OCR, instead
  // of client-filtering the shared top-50 feed which capped the review queue.
  const { data: pageData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ocr-review', page],
    queryFn: () => listDocuments((page - 1) * RECORDS_PAGE_SIZE, RECORDS_PAGE_SIZE, { ocrStatus: 'LOW_CONFIDENCE' }),
    staleTime: 30_000,
  });
  const lowOcrDocs = pageData?.data ?? [];
  const total = pageData?.total ?? lowOcrDocs.length;
  const totalPages = Math.max(1, Math.ceil(total / RECORDS_PAGE_SIZE));
  const loadError = isError;

  return (
    <>
      <div className="mb-8">
        <h2 className="text-xl font-bold text-text-primary">OCR Review</h2>
        <p className="text-text-muted mt-1">
          Review documents with low-confidence OCR results.
        </p>
      </div>

      <div className="bg-surface-card shadow-sm ring-1 ring-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="p-16 text-center">
            <RefreshCw className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-4" />
            <p className="text-text-muted">Loading records...</p>
          </div>
        ) : loadError ? (
          <ErrorState error={error} title="Unable to load OCR review data" onRetry={() => refetch()} />
        ) : lowOcrDocs.length === 0 ? (
          <div className="p-16 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-400 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-text-primary">All OCR Results are Confident</h3>
            <p className="text-text-muted mt-1 text-sm">
              No documents require OCR review.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border-subtle">
              <thead className="bg-surface-hover">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Document
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {lowOcrDocs.map((doc: any) => (
                  <tr
                    key={doc.id}
                    className="hover:bg-surface-hover/80 transition-colors group"
                  >
                    <td className="px-6 py-4">
                      <p className="text-sm font-semibold text-text-primary truncate max-w-xs">
                        {doc.title}
                      </p>
                      <p className="text-xs text-text-muted font-mono">
                        {doc.documentName}
                      </p>
                    </td>
                    <td className="px-6 py-4 text-xs text-text-muted">
                      {format(new Date(doc.createdAt), 'MMM d, yyyy')}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Link
                          href={`/dashboard/documents/${doc.id}`}
                          className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800"
                        >
                          <Eye className="h-3.5 w-3.5" /> Review
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {total > RECORDS_PAGE_SIZE && (
              <div className="border-t border-border-subtle px-4">
                <PaginationControls
                  page={page}
                  onPageChange={setPage}
                  hasPrevious={page > 1}
                  hasNext={page * RECORDS_PAGE_SIZE < total}
                  totalPages={totalPages}
                  isLoading={isLoading}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
