// Document detail page — tabs gated by permission, actions gated by permission.
// Each tab renders only if the principal holds the relevant permission string.
// Backend /auth/me is the authoritative source — no role-string checks here.
'use client';

import { use, useState, useEffect, useCallback, useMemo } from 'react';
import {
  useDocument,
  useAuditLogs,
  useWorkflowInstanceTasks,
} from '../../../../features/documents/hooks';
import { downloadDocumentUrl } from '../../../../features/documents/api';
import { apiClient, apiClientBlob, apiClientBlobResponse } from '../../../../shared/lib/apiClient';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  FileText,
  Clock,
  History,
  Shield,
  Info,
  Download,
  Lock,
  LockOpen,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Cpu,
  ChevronRight,
  Pen,
  RefreshCw,
  Eye,
  AlertTriangle,
  ShieldCheck,
  Gavel,
  MessageSquare,
  Paperclip,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { FileTypeIcon } from '../../../../shared/components/FileTypeIcon';
import { TopBar } from '../../../../shared/components/TopBar';
import { PermissionGate } from '../../../../shared/components/PermissionGate';
import { StatusBadge } from '../../../../shared/components/ui/StatusBadge';
import { SkeletonCard } from '../../../../shared/components/ui/SkeletonRow';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { useModalA11y } from '../../../../shared/hooks/useModalA11y';
import { useUIStore } from '../../../../state/ui.store';
import { fallbackPollInterval, useRealtimeStore } from '../../../../state/realtime.store';
import { cn } from '../../../../shared/lib/cn';
import { ScanStatusBadge } from '../../../../features/documents/ScanStatusBadge';
import { CommentsPanel } from '../../../../features/comments/CommentsPanel';
import { ClassificationControl } from '../../../../features/documents/ClassificationControl';
import { AddToBundleModal } from '../../../../features/bundles/AddToBundleModal';
import { VersionDiffModal } from '../../../../features/documents/VersionDiffModal';
import { ApprovalChainCard } from '../../../../features/approvals/ApprovalChainCard';
import { PdfBlobPreview } from '../../../../shared/components/PdfBlobPreview';
import { getApprovalChain, type ApprovalItemType } from '../../../../features/approvals/api';
import { getLetterByDocumentId } from '../../../../features/letters/api';
import { CorrespondenceApprovalChain } from '../../../../features/letters/CorrespondenceApprovalChain';
import toast from 'react-hot-toast';
import { useResetOnChange } from '../../../../shared/hooks/useResetOnChange';
import { pdfDocumentImport, pdfPageImport } from '../../../../shared/lib/pdfWorker';

// Dynamically imported (react-pdf pulls in pdfjs, a large parser this page
// doesn't need until a PDF file is actually being previewed). Worker setup
// lives in shared/lib/pdfWorker.ts — see its header comment for why it must
// run inside the dynamic() factory itself, not a useEffect, to avoid a
// `sendWithPromise` crash on the first preview of a session.
const PdfDocument = dynamic(pdfDocumentImport, { ssr: false });
const PdfPage = dynamic(pdfPageImport, { ssr: false });

// ─── Types ────────────────────────────────────────────────────────────────────

type DocVersion = {
  id: string;
  versionNumber: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number | bigint;
  sha256Hash: string;
  changeSummary: string;
  authorId: string;
  createdAt: string;
  // Computed by the backend's ClamAV scan (documents.service.ts) — 'clean' on
  // a completed scan with no threat, 'unscanned' when the scan didn't
  // complete (fail-open: the upload is still allowed through, just flagged).
  // Absent on legacy rows created before this column existed.
  avScanStatus?: 'clean' | 'unscanned';
  // Written by OCRWorker.ts once processing completes. Already shipped by
  // GET /documents/:id (the versions include has no attribute restriction) —
  // this was simply never read on the frontend before now.
  extractedText?: string | null;
};

type SignatureRequestRecord = {
  id: string;
  status: string;
  orderingMode: string;
  createdAt: string;
  recipients?: Array<{ id: string; name: string; email: string; status: string; orderIndex: number }>;
};

type DocRecord = Record<string, unknown> & {
  id: string;
  title: string;
  documentName: string;
  status: string;
  securityClassification: string;
  retentionClass: string;
  currentVersion: string;
  isOnLegalHold: boolean;
  ocrStatus?: string;
  ocrConfidenceScore?: number;
  organisationUnit: string;
  updatedAt: string;
  createdAt: string;
  versions?: DocVersion[];
  workflowInstances?: Record<string, unknown>[];
  signatures?: Record<string, unknown>[];
  signatureRequests?: SignatureRequestRecord[];
  formInstanceId?: string | null;
  legalHolds?: Record<string, unknown>[];
  checkout?: {
    checkedOutBy?: string;
    checkedOutByUser?: { id: string; firstName: string; lastName: string; email: string } | null;
    checkedOutAt?: string;
  } | null;
  metadata?: { description?: string; keywords?: string } | null;
  owner?: { firstName?: string; lastName?: string };
  department: { id?: string; code: string; name: string };
  documentType: { code: string; name: string; requiresApproval?: boolean };
};

type Tab =
  | 'overview'
  | 'preview'
  | 'versions'
  | 'comments'
  | 'workflow'
  | 'audit'
  | 'governance';

// Defined outside the component so the array reference is stable across renders
const TAB_DEFS: {
  key: Tab;
  label: string;
  icon: React.ElementType;
  // A single permission string, or an array meaning "any of" — see the
  // Workflow tab below for why this needed to become an "any of".
  permission: string | string[];
}[] = [
  { key: 'overview',    label: 'Overview',    icon: Info,         permission: 'document:read' },
  { key: 'preview',     label: 'File',         icon: Eye,          permission: 'document:read' },
  { key: 'versions',    label: 'Versions',    icon: History,      permission: 'document:read' },
  { key: 'comments',    label: 'Comments',    icon: MessageSquare, permission: 'document:read' },
  // FIX (2026-09-12): this tab hosts the ENTIRE unified approval engine —
  // ApprovalChainCard's chain view, and critically its self-service "Submit
  // for approval" button — not just the legacy workflow_instances read-only
  // panel `workflow:read` was actually written to gate. EMPLOYEE (and every
  // other author-only role) holds approval:submit/approval:decide but NOT
  // workflow:read (config/permissions.ts's ROLE_PERMISSIONS), so the one tab
  // that lets an author submit their own DRAFT document never rendered for
  // them at all — reported as "no submit-for-approval action anywhere on the
  // page," which was real: it existed, it was just behind a permission its
  // own intended users don't hold. The backend agrees this tab's content
  // isn't workflow:read-gated: GET .../chain requires only document:read,
  // and POST .../submit requires approval:submit (approvals.routes.ts) — no
  // route here checks workflow:read at all. Any of these three is enough to
  // have a reason to open the tab; ApprovalChainCard/CorrespondenceApprovalChain
  // make their own finer-grained checks for which buttons to show once inside.
  { key: 'workflow',    label: 'Workflow',    icon: Cpu,          permission: ['workflow:read', 'approval:submit', 'approval:decide'] },
  { key: 'audit',       label: 'Audit Trail', icon: ShieldCheck,  permission: 'audit:read' },
  { key: 'governance',  label: 'Governance',  icon: Gavel,        permission: 'signing:read' },
];

// ─── Document actions hook ─────────────────────────────────────────────────

function useDocumentActions(id: string) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback(
    async (action: string, fn: () => Promise<unknown>) => {
      setLoading(action);
      setActionError(null);
      try {
        await fn();
        qc.invalidateQueries({ queryKey: ['document', id] });
        qc.invalidateQueries({ queryKey: ['documents'] });
        qc.invalidateQueries({ queryKey: ['documents-list'] });
        qc.invalidateQueries({ queryKey: ['folder-contents'] });
        qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
        qc.invalidateQueries({ queryKey: ['my-work'] });
        qc.invalidateQueries({ queryKey: ['my-work-count'] });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Action failed';
        setActionError(msg);
      } finally {
        setLoading(null);
      }
    },
    [id, qc],
  );

  const checkout = useCallback(
    (notes?: string) =>
      run('checkout', () =>
        apiClient(`/documents/${id}/checkout`, {
          method: 'POST',
          body: JSON.stringify({ notes }),
        }),
      ),
    [id, run],
  );

  const cancelCheckout = useCallback(
    () =>
      run('checkin', () =>
        apiClient(`/documents/${id}/checkin`, { method: 'POST' }),
      ),
    [id, run],
  );

  const archive = useCallback(
    () =>
      run('archive', () =>
        apiClient(`/documents/${id}/archive`, { method: 'POST' }),
      ),
    [id, run],
  );

  // Reverse of archive — brings an ARCHIVED document back to ACTIVE.
  const activate = useCallback(
    () =>
      run('activate', () =>
        apiClient(`/documents/${id}/activate`, { method: 'POST' }),
      ),
    [id, run],
  );

  // Owner-driven shortcut for document types that opt out of the approval
  // chain (DocumentType.requiresApproval = false) — see publishDraft.
  const publish = useCallback(
    () =>
      run('publish', () =>
        apiClient(`/documents/${id}/publish`, { method: 'POST' }),
      ),
    [id, run],
  );

  // Restore an older version as a new latest version. Backend POST /:id/rollback
  // ({ versionId }) is gated by document:upload — previously had no UI at all.
  const rollback = useCallback(
    (versionId: string) =>
      run('rollback', () =>
        apiClient(`/documents/${id}/rollback`, {
          method: 'POST',
          body: JSON.stringify({ versionId }),
        }),
      ),
    [id, run],
  );

  // Admin recovery for a stuck lock (POST /:id/force-unlock). The normal
  // check-in path only lets the holder release their own lock; this releases
  // anyone's — previously unreachable from the UI.
  const forceUnlock = useCallback(
    (reason: string) =>
      run('force-unlock', () =>
        apiClient(`/documents/${id}/force-unlock`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      ),
    [id, run],
  );

  // Manual status transition (PATCH /:id/status). The valid options come from
  // GET /:id/allowed-transitions so the UI never offers an invalid/subsystem-only
  // one. Previously only bulk status change existed; the detail view had none.
  const changeStatus = useCallback(
    (toState: string) =>
      run('status', () =>
        apiClient(`/documents/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ toState }),
        }),
      ),
    [id, run],
  );

  // withCertificate defaults to false — the certificate-of-completion page a
  // completed e-sign ceremony appends is proof-of-ceremony metadata, not
  // part of the letter/document itself; most downloads want just the signed
  // pages. Pass true for the one case that does want it (audit/compliance).
  const download = useCallback(async (withCertificate = false) => {
    setLoading('download');
    setActionError(null);
    try {
      // apiClientBlobResponse (axios) rejects on non-2xx and gets the same
      // silent-refresh-on-401 retry every other request gets — a bare fetch()
      // here neither checked res.ok's sibling condition consistently across
      // call sites nor benefited from that retry (audit 2026-07-26 #14).
      const res = await apiClientBlobResponse(downloadDocumentUrl(id, { certificate: withCertificate }));
      const blob = res.data;
      const disposition = res.headers['content-disposition'] ?? '';
      // Prefer the RFC 5987 filename* (the real, possibly non-Latin name); the quoted
      // filename= is only an ASCII fallback the server adds for old clients.
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      let decodedName: string | undefined;
      try {
        decodedName = encodedName ? decodeURIComponent(encodedName) : undefined;
      } catch {
        decodedName = undefined;
      }
      const name =
        decodedName ?? disposition.match(/filename="([^"]+)"/)?.[1] ?? `document-${id}`;
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href: url,
        download: name,
      }).click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      // A bare "Failed to fetch" TypeError (no HTTP status ever received) means the
      // request never reached our error handling — typically a browser extension
      // (e.g. Internet Download Manager) intercepting the attachment response.
      const isLikelyExtensionInterception =
        err instanceof TypeError && /failed to fetch/i.test(err.message);
      const msg = isLikelyExtensionInterception
        ? 'Download was blocked by a browser extension (e.g. Internet Download Manager). Disable its integration for this site, or check your Downloads folder — the file may have already saved.'
        : err instanceof Error
          ? err.message
          : 'Download failed';
      setActionError(msg);
      toast.error(msg);
    } finally {
      setLoading(null);
    }
  }, [id]);

  // Hard delete — DRAFT only, skips Trash and the maker-checker purge flow
  // entirely (see backend trashService.deleteDraftPermanently). Deliberately
  // NOT routed through `run()`: that helper invalidates ['document', id] on
  // success, which would refetch a document that no longer exists. The
  // caller navigates away instead.
  const deletePermanently = useCallback(async () => {
    setLoading('delete-permanent');
    setActionError(null);
    try {
      await apiClient(`/documents/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents-list'] });
      qc.invalidateQueries({ queryKey: ['folder-contents'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
      throw err;
    } finally {
      setLoading(null);
    }
  }, [id, qc]);

  return { loading, actionError, checkout, cancelCheckout, archive, activate, publish, download, rollback, forceUnlock, changeStatus, deletePermanently };
}

// Detail-view status control: fetches the transitions this user may perform on
// this document and applies the chosen one. Renders nothing when there are none.
function StatusTransitionControl({ documentId, actions }: { documentId: string; actions: ReturnType<typeof useDocumentActions> }) {
  const qc = useQueryClient();
  const [toState, setToState] = useState('');
  const { data } = useQuery({
    queryKey: ['allowed-transitions', documentId],
    queryFn: () => apiClient<{ data: Array<{ toState: string; permission: string }> }>(`/documents/${documentId}/allowed-transitions`),
    staleTime: 15_000,
  });
  const options = data?.data ?? [];
  if (options.length === 0) return null;
  const apply = async () => {
    if (!toState) return;
    try {
      await actions.changeStatus(toState);
      toast.success(`Status changed to ${toState}`);
      setToState('');
      qc.invalidateQueries({ queryKey: ['document', documentId] });
      qc.invalidateQueries({ queryKey: ['allowed-transitions', documentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Status change failed');
    }
  };
  return (
    <div className="flex items-center gap-2">
      <select value={toState} onChange={(e) => setToState(e.target.value)} className="ui-input text-sm" title="Change document status">
        <option value="">Change status…</option>
        {options.map((o) => <option key={o.toState} value={o.toState}>{o.toState}</option>)}
      </select>
      <button onClick={apply} disabled={!toState || actions.loading === 'status'} className="ui-btn ui-btn-secondary">
        {actions.loading === 'status' ? 'Applying…' : 'Apply'}
      </button>
    </div>
  );
}

// ─── Version upload modal ──────────────────────────────────────────────────

function VersionUploadModal({
  docId,
  onClose,
}: {
  docId: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();

  const handleSubmit = async () => {
    if (!file) {
      setErr('Please select a file');
      return;
    }
    setUploading(true);
    setErr(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append(
        'changeSummary',
        summary.trim() || 'Version update via checkout',
      );
      formData.append('isMajor', 'false');
      // documents.service.ts's uploadVersion returns { success, versionNumber,
      // warnings } directly (no `data` envelope) — see POST /:id/versions.
      const res = await apiClient<{ success: boolean; versionNumber: string; warnings: string[] }>(
        `/documents/${docId}/versions`,
        { method: 'POST', body: formData },
      );
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents-list'] });
      qc.invalidateQueries({ queryKey: ['folder-contents'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
      if (res.warnings?.includes('WARN-UNSCANNED')) {
        toast(
          'New version uploaded — but it could not be scanned for viruses. It was still allowed through and is flagged for review.',
          {
            icon: '⚠️',
            duration: 8000,
            style: { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' },
          },
        );
      } else {
        toast.success('New version uploaded');
      }
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      const friendly =
        msg.includes('CHECKOUT') || msg.includes('checked out')
          ? 'This document must be checked out by you before uploading a new version.'
          : msg;
      setErr(friendly);
      toast.error(friendly);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-bold text-text-primary mb-1">
          Upload New Version
        </h2>
        <p className="text-sm text-text-muted mb-5">
          Upload the edited file to create a new version and check in the
          document.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              File <span className="text-rose-500">*</span>
            </label>
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="ui-input text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Change Summary
            </label>
            <textarea
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe what changed..."
              className="ui-input resize-none text-sm"
            />
          </div>
          {err && (
            <div className="flex items-center gap-2 text-rose-600 text-sm bg-rose-50 dark:bg-rose-900/20 border border-rose-200 rounded-xl px-3 py-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {err}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="ui-btn ui-btn-secondary">
            Cancel
          </button>
          <button
            disabled={uploading || !file}
            onClick={handleSubmit}
            className="ui-btn ui-btn-primary"
          >
            {uploading ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <Pen className="h-3.5 w-3.5" /> Upload & Check In
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Checkout modal ────────────────────────────────────────────────────────

function CheckoutModal({
  onConfirm,
  onClose,
  loading,
}: {
  onConfirm: (notes: string) => void;
  onClose: () => void;
  loading: boolean;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-bold text-text-primary mb-1">
          Check Out Document
        </h2>
        <p className="text-sm text-text-muted mb-4">
          You will have exclusive edit rights. Provide an optional checkout
          note.
        </p>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Updating quarterly figures…"
          className="ui-input resize-none text-sm mb-4"
        />
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="ui-btn ui-btn-secondary">
            Cancel
          </button>
          <button
            disabled={loading}
            onClick={() => onConfirm(note)}
            className="ui-btn ui-btn-primary"
          >
            {loading ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Checking out…
              </>
            ) : (
              <>
                <Lock className="h-3.5 w-3.5" /> Check Out
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── File preview component ────────────────────────────────────────────────


type AiSummaryStatus = 'ready' | 'disabled' | 'blocked' | 'pending' | 'failed';
type AiSummaryResponse = { aiSummary: string | null; status: AiSummaryStatus; blockedReason?: string | null };

// Distinguishes *why* no summary exists instead of one undifferentiated blank
// state — consent-off, never-attempted, and a failed job are different
// problems with different fixes, and the previous single message ("No AI
// summary has been generated yet.") looked identical for all three.
function aiSummaryStatusMessage(data: AiSummaryResponse | undefined, isError: boolean): string {
  if (data?.aiSummary) return data.aiSummary;
  if (isError) return 'AI summary is unavailable for this document.';
  switch (data?.status) {
    case 'disabled':
      return 'AI features are disabled for this tenant — a tenant admin must enable the "ai_processing" feature flag before a summary can be generated.';
    case 'blocked':
      return data.blockedReason ?? "AI is not allowed for this document under your organisation's AI policy.";
    case 'failed':
      return 'The last summarization attempt failed. Try "Summarize" again, or check the operations pipeline panel for the underlying error.';
    case 'pending':
    default:
      return 'No AI summary has been generated yet — use "Summarize" to request one.';
  }
}

function AIInsightsCard({ docId }: { docId: string }) {
  const qc = useQueryClient();
  const socketConnected = useRealtimeStore((s) => s.connected);
  const summary = useQuery({
    queryKey: ['ai', 'summary', docId],
    queryFn: () => apiClient<{ data: AiSummaryResponse }>(`/ai/documents/${docId}/summary`),
    retry: 1,
    // F-06 follow-up: the original comment here — "AIWorker runs in a separate
    // process from this request, so a queued job can't push its result back"
    // — was not true. The worker writes a WEBSOCKET outbox row and the API
    // process emits it (enqueueWebsocketEvent in AIWorker.ts). Two things had
    // to be fixed before this poll could stop being the mechanism:
    //   1. ["ai"] was missing from RealtimeBridge's invalidation map, so the
    //      event that already existed never touched this query.
    //   2. The event fired on the SUCCESS path only — a failed job, a job with
    //      too little extracted text, or a tenant without AI consent emitted
    //      nothing at all, so the card would have hung on "queued" forever.
    //      AIWorker now pushes on every terminal outcome.
    // With both fixed the socket resolves this card, and the interval is a
    // socket-down fallback: still only while pending, so a settled card costs
    // nothing either way.
    refetchInterval: (query) =>
      query.state.data?.data.status === 'pending' ? fallbackPollInterval(socketConnected) : false,
  });
  const suggestions = useQuery({
    queryKey: ['ai', 'suggestions', docId],
    queryFn: () => apiClient<{ data: { aiSuggestedMetadata: Record<string, unknown> | null } }>(`/ai/documents/${docId}/suggestions`),
    retry: 1,
  });
  const [awaitingSummary, setAwaitingSummary] = useState(false);
  useResetOnChange([summary.data?.data.status], () => {
    if (summary.data?.data.status !== 'pending') setAwaitingSummary(false);
  });
  const summarize = useMutation({
    mutationFn: () => apiClient(`/ai/documents/${docId}/summarize`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Summarization queued — this card updates automatically once it finishes.');
      setAwaitingSummary(true);
      qc.invalidateQueries({ queryKey: ['ai', 'summary', docId] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'AI queue unavailable'),
  });
  const extract = useMutation({
    mutationFn: () => apiClient(`/ai/documents/${docId}/extract`, { method: 'POST' }),
    onSuccess: () => { toast.success('Metadata extraction queued'); qc.invalidateQueries({ queryKey: ['ai', 'suggestions', docId] }); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'AI queue unavailable'),
  });
  // Only these keys (written by AIWorker.extractMetadata) map onto real
  // Document/DocumentMetadata columns — see applyAiSuggestedMetadataField in
  // backend documents.service.ts. Other keys are shown read-only.
  const APPLICABLE_FIELDS = new Set(['suggestedClassification', 'suggestedDocumentDate', 'suggestedLanguage', 'suggestedKeywords', 'summary']);
  const [appliedFields, setAppliedFields] = useState<Set<string>>(new Set());
  const applySuggestion = useMutation({
    mutationFn: ({ field, value }: { field: string; value: unknown }) =>
      apiClient(`/documents/${docId}/metadata/apply-suggestion`, { method: 'PATCH', body: JSON.stringify({ field, value }) }),
    onSuccess: (_data, { field }) => {
      toast.success('Suggestion applied');
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['ai', 'suggestions', docId] });
      setAppliedFields((prev) => new Set(prev).add(field));
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to apply suggestion'),
  });
  const suggested = suggestions.data?.data.aiSuggestedMetadata;
  const refreshing = summary.isFetching || suggestions.isFetching;

  return (
    <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
      <div className="ui-card">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary"><Cpu className="h-4 w-4 text-brand-600" /> AI Insights</h2>
          <div className="flex gap-2">
            <button
              onClick={() => { summary.refetch(); suggestions.refetch(); }}
              disabled={refreshing}
              title="Refresh AI insights"
              className="ui-btn ui-btn-secondary !py-1.5 !px-2 text-xs"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            </button>
            <PermissionGate permission={PERMISSIONS.AI_USE}>
              <button onClick={() => summarize.mutate()} disabled={summarize.isPending} className="ui-btn ui-btn-secondary !py-1.5 text-xs">Summarize</button>
              <button onClick={() => extract.mutate()} disabled={extract.isPending} className="ui-btn ui-btn-secondary !py-1.5 text-xs">Suggest metadata</button>
            </PermissionGate>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-text-secondary">{aiSummaryStatusMessage(summary.data?.data, summary.isError)}</p>
        {awaitingSummary && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-brand-600">
            <RefreshCw className="h-3 w-3 animate-spin" /> Summarizing… this card will update automatically (usually under a minute).
          </p>
        )}
        {suggested && (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(suggested).slice(0, 8).map(([k, v]) => {
              const canApply = APPLICABLE_FIELDS.has(k) && v != null && v !== '';
              const applied = appliedFields.has(k);
              return (
                <span key={k} className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px]" style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}>
                  {k}: {Array.isArray(v) ? v.join(', ') : String(v)}
                  {canApply && (
                    <button
                      onClick={() => applySuggestion.mutate({ field: k, value: v })}
                      disabled={applySuggestion.isPending || applied}
                      className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-50"
                      title={`Apply ${k} to this document`}
                    >
                      {applied ? 'Applied' : 'Apply'}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </PermissionGate>
  );
}

// Renders the actual OCR result — this data has always been shipped by
// GET /documents/:id (DocumentVersion has no attribute restriction on that
// include), it was simply never rendered anywhere on this page. Every empty
// state below names the real reason instead of a blank card, since a 99%
// confidence badge with nothing underneath it is exactly the "looks broken
// but isn't obviously why" gap this replaces.
function ExtractedTextCard({
  ocrStatus,
  ocrConfidenceScore,
  extractedText,
}: {
  ocrStatus?: string;
  ocrConfidenceScore?: number;
  extractedText?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasText = Boolean(extractedText && extractedText.trim().length > 0);

  let emptyMessage = 'Text extraction has not completed for this document yet.';
  if (ocrStatus === 'FAILED') emptyMessage = 'OCR failed for this document — no text was extracted.';
  else if (ocrStatus === 'OCR_UNSUPPORTED') emptyMessage = 'This file type is not supported for text extraction.';
  else if (ocrStatus === 'COMPLETED' || ocrStatus === 'LOW_CONFIDENCE') emptyMessage = 'OCR completed but produced no readable text for this file.';

  return (
    <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
      <div className="ui-card">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
            <FileText className="h-4 w-4 text-brand-600" /> Extracted Text
          </h2>
          <span
            className={cn(
              'text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider',
              ocrStatus === 'COMPLETED'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : ocrStatus === 'FAILED'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
            )}
          >
            {ocrStatus ?? 'PENDING'}
            {ocrConfidenceScore != null ? ` · ${Math.round(ocrConfidenceScore)}%` : ''}
          </span>
        </div>
        {hasText ? (
          <>
            <div
              className={cn(
                'overflow-y-auto rounded-xl border border-border bg-surface-secondary p-4 transition-all',
                expanded ? 'max-h-[32rem]' : 'max-h-40',
              )}
            >
              <pre className="whitespace-pre-wrap break-words text-xs font-mono leading-relaxed text-text-secondary">
                {extractedText}
              </pre>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-[11px] text-text-muted">
                {extractedText!.length.toLocaleString()} characters extracted
              </p>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-[11px] font-semibold text-brand-600 hover:underline"
              >
                {expanded ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted italic">{emptyMessage}</p>
        )}
      </div>
    </PermissionGate>
  );
}

function StorageFiles({ doc }: { doc: DocRecord }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);
  // Which `${doc.id}:${version.id}` the current blobUrl/blobError belong to.
  // `loadingBlob` is derived from it below rather than being its own flag.
  const [settledBlobKey, setSettledBlobKey] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [showPreview, setShowPreview] = useState(true);

  const version = doc.versions?.[0];
  const mime: string = (version?.mimeType as string) ?? '';
  const isPreviewable = mime === 'application/pdf' || mime.startsWith('image/');
  const loadingBlob =
    isPreviewable && !!version && settledBlobKey !== `${doc.id}:${version.id}`;

  // A new document/version always restarts preview pagination at page 1 —
  // mirrors PdfBlobPreview.tsx's useResetOnChange. Without this, navigating
  // from a multi-page PDF to a shorter one could leave `pageNum` pointing
  // past the new document's last page.
  useResetOnChange([doc.id, version?.id], () => {
    setPageNum(1);
    setNumPages(0);
  });

  // The fetch no longer raises `loadingBlob` synchronously — it clears the
  // previous version's result instead, and `loadingBlob` is DERIVED from
  // whether a result for the current version has arrived yet (see its
  // declaration above). Besides satisfying react-hooks/set-state-in-effect,
  // that removes a way the two could disagree: a flag set in an effect and
  // cleared in a `finally` is one early return away from a spinner that never
  // stops.
  useEffect(() => {
    if (!version || !isPreviewable) return;
    let objectUrl: string | null = null;
    const requestKey = `${doc.id}:${version.id}`;

    apiClientBlob(downloadDocumentUrl(doc.id))
      .then((b) => {
        objectUrl = URL.createObjectURL(b);
        setBlobUrl(objectUrl);
        setSettledBlobKey(requestKey);
      })
      .catch((e: Error) => {
        setBlobError(e.message);
        setSettledBlobKey(requestKey);
      });

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // doc.id alone is NOT enough: after VersionUploadModal uploads a new
    // version, the document query is invalidated and refetched but doc.id is
    // unchanged, so this effect never re-ran and the preview kept showing the
    // stale previous version's blob. version?.id changes whenever the current
    // version does (a new version becomes versions[0]), which is what
    // actually needs to trigger a re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, version?.id]);

  if (!version) {
    return (
      <div className="p-10 text-center">
        <FileText className="h-10 w-10 text-text-muted mx-auto mb-3" />
        <p className="text-sm text-text-muted">
          No file has been uploaded yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* File info bar */}
      <div className="flex items-center justify-between p-3 bg-surface-raised rounded-xl border border-border">
        <div className="flex items-center gap-3">
          <FileTypeIcon mimeType={mime} size={20} />
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {version.originalFilename}
            </p>
            <p className="text-xs text-text-muted truncate max-w-xs">
              {mime} · {(Number(version.fileSize) / 1024).toFixed(1)} KB · v
              {version.versionNumber}
            </p>
            <div className="mt-1">
              <ScanStatusBadge status={(version as { avScanStatus?: string | null }).avScanStatus} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isPreviewable && (
            <button
              onClick={() => setShowPreview((v) => !v)}
              className="ui-btn ui-btn-secondary py-1.5 text-xs"
            >
              <Eye className="h-3.5 w-3.5" />
              {showPreview ? 'Hide Preview' : 'Show Preview'}
            </button>
          )}
        </div>
      </div>

      {/* Preview */}
      {isPreviewable && showPreview && (
        <div className="border border-border rounded-xl overflow-hidden bg-surface-raised">
          {loadingBlob && (
            <div className="flex items-center justify-center h-48 gap-3">
              <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
              <span className="text-sm text-text-muted">Loading preview…</span>
            </div>
          )}
          {blobError && (
            <div className="flex items-center justify-center h-32 gap-2 text-rose-600">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{blobError}</span>
            </div>
          )}
          {blobUrl && mime === 'application/pdf' && (
            <div className="flex flex-col items-center">
              <PdfDocument
                key={`${doc.id}:${version.id}`}
                file={blobUrl}
                onLoadSuccess={({ numPages: n }) => setNumPages(n)}
                loading={
                  <div className="h-48 flex items-center justify-center">
                    <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
                  </div>
                }
                error={
                  <div className="h-32 flex items-center justify-center text-sm text-rose-500">
                    Failed to render PDF
                  </div>
                }
                className="w-full"
              >
                <PdfPage
                  pageNumber={pageNum}
                  width={Math.min(
                    680,
                    typeof window !== 'undefined'
                      ? window.innerWidth - 80
                      : 680,
                  )}
                  renderTextLayer
                  renderAnnotationLayer
                />
              </PdfDocument>
              {numPages > 1 && (
                <div className="border-t border-border w-full px-4">
                  <PaginationControls
                    page={pageNum}
                    onPageChange={setPageNum}
                    hasPrevious={pageNum > 1}
                    hasNext={pageNum < numPages}
                    totalPages={numPages}
                  />
                </div>
              )}
            </div>
          )}
          {blobUrl && mime.startsWith('image/') && (
            <div className="p-4 flex justify-center">
              {/* A blob: URL created from the decrypted download — next/image
                  cannot optimise or even fetch one, and there is no remote URL
                  to hand it. Same reason as the signature preview in
                  ProfileSettingsPanel. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={blobUrl}
                alt={doc.title}
                className="max-w-full max-h-[600px] rounded-lg object-contain"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// CorrespondenceApprovalChain now lives in
// features/letters/CorrespondenceApprovalChain.tsx (extracted for unit
// testability — see its own test file).

// ─── Workflow stage timeline ────────────────────────────────────────────────

function humanizeRole(role: string): string {
  return role
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const TASK_STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-green-50 text-green-700 border-green-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
};

function WorkflowSlaBadge({ deadline }: { deadline: string }) {
  const date = new Date(deadline);
  const breached = isPast(date);
  const distanceText = formatDistanceToNow(date, { addSuffix: true });
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border',
        breached ? 'text-red-600 bg-red-50 border-red-200' : 'text-amber-600 bg-amber-50 border-amber-200',
      )}
    >
      <AlertTriangle className="h-3 w-3" /> {breached ? 'SLA breached' : 'Due'} {distanceText}
    </span>
  );
}

function WorkflowStageTimeline({ instanceId }: { instanceId: string }) {
  const { data: tasks, isLoading } = useWorkflowInstanceTasks(instanceId);

  if (isLoading) {
    return <p className="text-sm text-text-muted">Loading stage history...</p>;
  }
  if (!tasks || tasks.length === 0) {
    return <p className="text-sm text-text-muted">No stages recorded yet.</p>;
  }

  return (
    <div className="space-y-3">
      {tasks.map((task: any) => {
        const isCurrent = task.status === 'PENDING';
        const assignee = task.assignedToUserId
          ? 'Assigned user'
          : task.assignedToRole
            ? humanizeRole(String(task.assignedToRole))
            : '—';
        return (
          <div
            key={task.id}
            className={cn(
              'p-3 rounded-xl border',
              isCurrent ? 'bg-surface-raised border-brand-200' : 'bg-surface-base border-border opacity-80',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black text-text-muted uppercase tracking-wider">
                  Stage {task.stageNumber}
                </span>
                <span className="text-sm font-semibold text-text-primary">{task.stageName}</span>
              </div>
              <span
                className={cn(
                  'text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border',
                  TASK_STATUS_STYLE[task.status] ?? 'bg-surface-raised text-text-muted border-border',
                )}
              >
                {task.status}
              </span>
            </div>
            <p className="text-xs text-text-muted">
              Assigned to <span className="font-medium text-text-secondary">{assignee}</span>
            </p>
            {task.decision && (
              <p className="text-xs text-text-muted mt-1">
                {task.decision} {task.decidedAt ? `on ${format(new Date(task.decidedAt), 'PPp')}` : ''}
                {task.decisionReason ? ` — "${task.decisionReason}"` : ''}
              </p>
            )}
            {isCurrent && task.slaDeadlineAt && (
              <div className="mt-2">
                <WorkflowSlaBadge deadline={task.slaDeadlineAt} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: doc, isLoading, isError, error } = useDocument(id);
  const { data: auditLogs } = useAuditLogs({ documentId: id });
  // Same queryKey ApprovalChainCard uses internally — React Query dedupes
  // the two, so this is a header-level READ of that same cached chain, not
  // an extra request. Powers the "waiting on X · step 2/3" summary next to
  // the title and the pending-dot on the Workflow tab, so the route's
  // current status is visible without clicking in (audit UX sweep).
  const headerChainItemType: ApprovalItemType = (doc as any)?.formInstanceId ? 'FORM_INSTANCE' : 'DOCUMENT';
  const headerChainItemId: string = (doc as any)?.formInstanceId ?? id;
  const { data: headerChain } = useQuery({
    queryKey: ['approval-chain', headerChainItemType, headerChainItemId],
    queryFn: () => getApprovalChain(headerChainItemType, headerChainItemId),
    enabled: Boolean(doc),
  });
  // CORR-type documents are a letter's filed final PDF/attachment/cover
  // sheet — letters run their OWN approval chain (letter_approval_steps),
  // entirely separate from the unified engine headerChain queries above, so
  // a letter-backed document always showed "Not submitted yet" on its
  // Workflow tab even after a real, completed review/approve chain. Only
  // fetch for CORR docs — this 404-free lookup returns null for everything
  // else, so gating on the type avoids a pointless request on every page.
  const isCorrDocument = (doc as any)?.documentType?.code === 'CORR';
  const { data: linkedLetterRes } = useQuery({
    queryKey: ['letter-by-document', id],
    queryFn: () => getLetterByDocumentId(id),
    enabled: isCorrDocument,
  });
  const linkedLetter = linkedLetterRes?.data ?? null;
  const actions = useDocumentActions(id);
  // FIX (platform audit finding 2026-08-14): the Archive shortcut button
  // below used to gate on a hardcoded ['ACTIVE','SIGNED'] list that didn't
  // match DocumentStateMachine.ts's real MANUAL_TRANSITION_PERMISSIONS map —
  // APPROVED->ARCHIVED and AUDITED->ARCHIVED are also valid, so a document
  // sitting in either of those (both common, reachable states) had no
  // Archive button at all despite the user holding document:archive. Same
  // queryKey StatusTransitionControl uses internally — React Query dedupes
  // the two, so this is a read of that same cached list, not an extra
  // request. See that component for the endpoint (GET :id/allowed-transitions).
  const { data: allowedTransitionsData } = useQuery({
    queryKey: ['allowed-transitions', id],
    queryFn: () => apiClient<{ data: Array<{ toState: string; permission: string }> }>(`/documents/${id}/allowed-transitions`),
    staleTime: 15_000,
  });
  const canArchiveNow = (allowedTransitionsData?.data ?? []).some((t) => t.toState === 'ARCHIVED');
  // Reverse of the above: the document is currently ARCHIVED and this user
  // holds document:archive — the allowed-transitions endpoint only ever
  // returns edges FROM the document's current status, so a bare
  // toState === 'ACTIVE' match would also fire for APPROVED/SIGNED/AUDITED/
  // QUARANTINED (they have their own ->ACTIVE edges for other purposes).
  // Gating on the current status too keeps this button specifically the
  // Archive button's reverse, not a second "publish" shortcut.
  const canActivateNow =
    (doc as any)?.status === 'ARCHIVED' &&
    (allowedTransitionsData?.data ?? []).some((t) => t.toState === 'ACTIVE');
  const { can, canAny } = usePermissions();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const requested = searchParams.get('tab');
    return TAB_DEFS.some((t) => t.key === requested) ? (requested as Tab) : 'overview';
  });
  const [showCheckout, setShowCheckout] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddToBundle, setShowAddToBundle] = useState(false);
  const [showVersionDiff, setShowVersionDiff] = useState(false);
  // audit 2026-08-11 UI/UX sweep #3: force-unlock/discard used native
  // window.prompt()/window.confirm() instead of the app's own Modal — ported
  // to the same accessible pattern used elsewhere (ApprovalChainCard.tsx).
  const [forceUnlockModalOpen, setForceUnlockModalOpen] = useState(false);
  const [forceUnlockReason, setForceUnlockReason] = useState('');
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [deletePermanentlyConfirmOpen, setDeletePermanentlyConfirmOpen] = useState(false);
  // Workflow tab, FORM_INSTANCE only: an approver deciding on a filed form
  // had to switch to the File tab to see what they were actually approving —
  // letters/[id]/page.tsx's own approval chain shows its PDF preview inline
  // right above the chain for exactly this reason. Same on-demand pattern
  // (button-triggered, not auto-fetched — this is a full document download,
  // not worth doing on every workflow-tab visit for someone just checking
  // approval status).
  const [formPreviewUrl, setFormPreviewUrl] = useState<string | null>(null);
  const loadFormPreview = async () => {
    try {
      const blob = await apiClientBlob(downloadDocumentUrl(id));
      const url = URL.createObjectURL(blob);
      setFormPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    }
  };
  useModalA11y(forceUnlockModalOpen, () => setForceUnlockModalOpen(false));
  useModalA11y(discardConfirmOpen, () => setDiscardConfirmOpen(false));
  useModalA11y(deletePermanentlyConfirmOpen, () => setDeletePermanentlyConfirmOpen(false));

  const visibleTabs = useMemo(
    () => TAB_DEFS.filter((t) => (Array.isArray(t.permission) ? canAny(t.permission) : can(t.permission))),
    [can, canAny],
  );

  // Default to first visible tab when permissions change. `activeTab` is
  // deliberately not one of the change keys — this fires when the tab SET
  // changes, not on every tab click.
  useResetOnChange([visibleTabs], () => {
    if (visibleTabs.length > 0 && !visibleTabs.find((t) => t.key === activeTab)) {
      setActiveTab(visibleTabs[0].key);
    }
  });

  // ── Loading state ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <>
        <TopBar
          title="Loading…"
          breadcrumbs={[
            { label: 'Repository', href: '/dashboard' },
            { label: '…' },
          ]}
          onMobileMenuToggle={toggleSidebar}
        />
        <div className="p-6 max-w-5xl mx-auto space-y-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={3} />
        </div>
      </>
    );
  }

  // ── Error / not found state ───────────────────────────────────────────────
  if (isError || !doc) {
    return (
      <>
        <TopBar title="Error" onMobileMenuToggle={toggleSidebar} />
        <div className="p-12 text-center">
          <AlertCircle className="h-12 w-12 text-rose-500 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-text-primary mb-2">
            {isError ? 'Could not load document' : 'Document not found'}
          </h3>
          <p className="text-text-muted text-sm mb-6">
            {isError
              ? ((error as Error)?.message ??
                'The server rejected this request.')
              : 'No document exists with this ID.'}
          </p>
          <Link href="/dashboard" className="ui-btn ui-btn-primary">
            Return to Dashboard
          </Link>
        </div>
      </>
    );
  }

  const typedDoc = doc as unknown as DocRecord;
  const activeWorkflow = typedDoc.workflowInstances?.[0] as
    | Record<string, unknown>
    | undefined;
  const isCheckedOut = !!typedDoc.checkout;
  const isOnHold = typedDoc.isOnLegalHold;
  const auditList = (auditLogs as unknown[]) ?? [];

  // Real antivirus state for the Integrity Pulse panel (previously hardcoded
  // to a permanent green "No threats detected", even for a QUARANTINED doc).
  // Precedence: a confirmed threat (document status) outranks the scan flag
  // on the current version, which outranks an in-flight async scan.
  const latestVersion = typedDoc.versions?.[0];
  // Mirrors documents.service.ts's PADES_CHANGE_SUMMARY (esignPades.ts) —
  // only used here to decide whether the "With certificate" download option
  // is worth showing at all, not to gate anything security-relevant.
  const isPadesSigned = Boolean(latestVersion?.changeSummary?.startsWith('E-sign: PAdES-signed'));
  const avStatus: 'quarantined' | 'scan_pending' | 'clean' | 'unscanned' | 'unknown' =
    typedDoc.status === 'QUARANTINED'
      ? 'quarantined'
      : typedDoc.status === 'SCAN_PENDING'
        ? 'scan_pending'
        : latestVersion?.avScanStatus === 'clean'
          ? 'clean'
          : latestVersion?.avScanStatus === 'unscanned'
            ? 'unscanned'
            : 'unknown';

  return (
    <>
      <TopBar
        title={typedDoc.title}
        breadcrumbs={[
          { label: 'Repository', href: '/dashboard' },
          { label: typedDoc.department.code, href: '/dashboard/browse' },
          { label: typedDoc.title },
        ]}
        onMobileMenuToggle={toggleSidebar}
      />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* ── Document header ──────────────────────────────────────────── */}
          <div className="ui-hero flex flex-col gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <h1 className="text-2xl font-extrabold text-text-primary tracking-tight break-words">
                  {typedDoc.title}
                </h1>
                <StatusBadge status={typedDoc.status} />
                {headerChain && (
                  <button
                    onClick={() => setActiveTab('workflow')}
                    className={cn(
                      'px-2.5 py-0.5 text-xs font-bold rounded-full border flex items-center gap-1.5 transition-colors',
                      headerChain.status === 'IN_REVIEW'
                        ? 'bg-brand-50 text-brand-700 border-brand-200 hover:bg-brand-100 dark:bg-brand-900/20 dark:text-brand-300 dark:border-brand-800'
                        : headerChain.status === 'APPROVED'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800'
                          : headerChain.status === 'DECLINED' || headerChain.status === 'CANCELLED'
                            ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800'
                            : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800',
                    )}
                    title="Jump to the Workflow tab"
                  >
                    {headerChain.status === 'IN_REVIEW' && <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse" />}
                    {headerChain.status === 'IN_REVIEW'
                      ? (() => {
                          const steps = headerChain.steps ?? [];
                          const pending = steps.find((s) => s.status === 'PENDING');
                          const who = pending
                            ? pending.assignedUser
                              ? `${pending.assignedUser.firstName} ${pending.assignedUser.lastName}`
                              : (pending.assignedRole ?? '').replace(/_/g, ' ')
                            : null;
                          return who
                            ? `Waiting on ${who} · step ${pending!.stepOrder}/${steps.length}`
                            : `In review · ${headerChain.progress?.done ?? 0}/${headerChain.progress?.total ?? steps.length}`;
                        })()
                      : headerChain.status === 'APPROVED'
                        ? 'Approved'
                        : headerChain.status === 'CHANGES_REQUESTED'
                          ? 'Changes requested'
                          : headerChain.status === 'DECLINED'
                            ? 'Declined'
                            : 'Chain cancelled'}
                  </button>
                )}
                {isOnHold && (
                  <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded-full border border-red-200">
                    🔒 LEGAL HOLD
                  </span>
                )}
                {isCheckedOut && (
                  <span
                    className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded-full border border-amber-200"
                    title={
                      typedDoc.checkout?.checkedOutByUser
                        ? `Checked out by ${typedDoc.checkout.checkedOutByUser.firstName} ${typedDoc.checkout.checkedOutByUser.lastName} (${typedDoc.checkout.checkedOutByUser.email})${typedDoc.checkout.checkedOutAt ? ` on ${format(new Date(typedDoc.checkout.checkedOutAt), 'PPp')}` : ''}`
                        : undefined
                    }
                  >
                    ✏ CHECKED OUT{typedDoc.checkout?.checkedOutByUser ? ` BY ${typedDoc.checkout.checkedOutByUser.firstName.toUpperCase()} ${typedDoc.checkout.checkedOutByUser.lastName.toUpperCase()}` : ''}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <span className="font-mono bg-surface-raised px-2 py-0.5 rounded">
                  {typedDoc.documentName}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Updated {format(new Date(typedDoc.updatedAt), 'PPp')}
                </span>
                <ClassificationControl
                  documentId={typedDoc.id as string}
                  classification={typedDoc.securityClassification}
                  ownerId={(typedDoc.ownerId as string) ?? null}
                />
              </div>
            </div>

            {/* Action buttons — each gated by permission */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                onClick={() => actions.download()}
                disabled={actions.loading === 'download'}
                className="ui-btn ui-btn-secondary"
                title={isPadesSigned ? 'Download the signed pages, without the certificate-of-completion page' : undefined}
              >
                {actions.loading === 'download' ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Download
              </button>
              {/* Only a completed e-sign ceremony's filed copy carries a
                  certificate-of-completion page to optionally include —
                  ordinary documents have nothing this second option would
                  change, so it stays hidden rather than offering a
                  no-op duplicate of the button above. */}
              {isPadesSigned && (
                <button
                  onClick={() => actions.download(true)}
                  disabled={actions.loading === 'download'}
                  className="ui-btn ui-btn-secondary !px-2.5 text-[12px]"
                  title="Download the real signed copy, including the certificate-of-completion page"
                >
                  <ShieldCheck className="h-3.5 w-3.5" /> With certificate
                </button>
              )}

              <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
                <button
                  onClick={() => setShowAddToBundle(true)}
                  className="ui-btn ui-btn-secondary"
                  title="Add to bundle"
                >
                  <Paperclip className="h-4 w-4" /> Add to Bundle
                </button>
              </PermissionGate>

              <PermissionGate permission={PERMISSIONS.DOCUMENT_CHECKOUT}>
                {isCheckedOut ? (
                  <>
                    <button
                      onClick={() => setShowUpload(true)}
                      disabled={!!actions.loading}
                      className="ui-btn ui-btn-primary"
                    >
                      <Pen className="h-4 w-4" /> New Version
                    </button>
                    <button
                      onClick={() => actions.cancelCheckout()}
                      disabled={!!actions.loading}
                      className="ui-btn ui-btn-secondary"
                    >
                      <LockOpen className="h-4 w-4" /> Cancel Checkout
                    </button>
                    <button
                      onClick={() => { setForceUnlockReason(''); setForceUnlockModalOpen(true); }}
                      disabled={!!actions.loading}
                      title="Admin recovery: release a lock held by another user"
                      className="ui-btn ui-btn-secondary"
                      style={{ color: 'var(--danger)' }}
                    >
                      <LockOpen className="h-4 w-4" /> Force Unlock
                    </button>
                  </>
                ) : (
                  <button
                    disabled={
                      isOnHold ||
                      !!actions.loading ||
                      // FIX (platform audit finding 2026-08-14): this used to
                      // allow-list ['ACTIVE','DRAFT','UNDER_REVIEW','PUBLISHED']
                      // — UNDER_REVIEW/PUBLISHED don't exist in
                      // DocumentStateMachine.ts's real states (leftover from a
                      // pre-rename naming scheme), and the list omitted very
                      // common real states (APPROVED, IN_REVIEW, SIGNED,
                      // PENDING_SIGNATURE, ARCHIVED, ...) that the backend's
                      // checkoutDocument() actually allows checkout from —
                      // it only ever blocks a genuinely terminal/trashed
                      // document (documentGuards.ts's assertNotTerminalState/
                      // assertNotTrashed). Deny-list those instead, matching
                      // the backend's real, narrow set of blocked states.
                      ['DISPOSED', 'PRESERVED', 'CANCELLED', 'TRASHED'].includes(typedDoc.status)
                    }
                    onClick={() => setShowCheckout(true)}
                    className="ui-btn ui-btn-primary"
                  >
                    <Lock className="h-4 w-4" /> Check Out
                  </button>
                )}
              </PermissionGate>

              <PermissionGate permission={PERMISSIONS.DOCUMENT_ARCHIVE}>
                {canArchiveNow && (
                  <button
                    onClick={() => actions.archive()}
                    disabled={isOnHold || !!actions.loading}
                    className="ui-btn ui-btn-secondary"
                  >
                    Archive
                  </button>
                )}
                {canActivateNow && (
                  <button
                    onClick={() => actions.activate()}
                    disabled={isOnHold || !!actions.loading}
                    className="ui-btn ui-btn-secondary"
                  >
                    Activate
                  </button>
                )}
              </PermissionGate>

              {/* Owner-driven shortcut for document types that opt out of
                  approval (DocumentType.requiresApproval = false) — see
                  publishDraft. Approval-required types leave DRAFT only via
                  ApprovalChainCard's "Submit for approval". */}
              {typedDoc.status === 'DRAFT' && typedDoc.documentType.requiresApproval === false && (
                <PermissionGate permission={PERMISSIONS.DOCUMENT_UPLOAD}>
                  <button
                    onClick={() => actions.publish()}
                    disabled={isOnHold || !!actions.loading}
                    className="ui-btn ui-btn-primary"
                    title="This document type does not require approval — publish it directly"
                  >
                    Publish
                  </button>
                </PermissionGate>
              )}
              {typedDoc.status === 'DRAFT' && (
                <PermissionGate permission={PERMISSIONS.DOCUMENT_UPLOAD}>
                  <button
                    onClick={() => setDiscardConfirmOpen(true)}
                    disabled={isOnHold || !!actions.loading}
                    className="ui-btn ui-btn-secondary"
                  >
                    Discard
                  </button>
                </PermissionGate>
              )}
              {typedDoc.status === 'DRAFT' && (
                <PermissionGate permission={PERMISSIONS.DOCUMENT_UPLOAD}>
                  <button
                    onClick={() => setDeletePermanentlyConfirmOpen(true)}
                    disabled={isOnHold || !!actions.loading}
                    className="ui-btn ui-btn-danger"
                    title="Permanently delete this draft right now — skips Trash entirely and cannot be undone"
                  >
                    Delete Permanently
                  </button>
                </PermissionGate>
              )}

              <StatusTransitionControl documentId={id} actions={actions} />
            </div>
          </div>

          {/* This document is a letter's superseded signed-draft artifact
              (or its cover sheet/staged attachment) — finalizeLetterAfterSigning
              (letters.service.ts) deliberately never edits the bytes actually
              signed (that would invalidate the signature), so it always still
              reads "DRAFT — PENDING SIGNATURE" and never gains a reference
              number/date, even long after the letter is fully approved and
              filed. Without this banner that reads as a bug — the real
              numbered letter is a SEPARATE Document row (linkedLetter.documentId),
              easy to land on the wrong one of the two from Browse/Search. */}
          {isCorrDocument && linkedLetter?.documentId && linkedLetter.documentId !== id && (
            <div className="flex items-center gap-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-amber-800 dark:text-amber-300 text-sm">
              <Info className="h-4 w-4 shrink-0" />
              <span className="flex-1">
                This is the signed draft — kept exactly as signed so the signature stays valid, so it still shows
                &quot;DRAFT — PENDING SIGNATURE&quot; with no reference number.{' '}
                {linkedLetter.referenceNumber
                  ? <>The finalized letter of record is <span className="font-mono font-semibold">{linkedLetter.referenceNumber}</span>.</>
                  : 'The finalized letter of record has since been filed separately.'}
              </span>
              <Link href={`/dashboard/documents/${linkedLetter.documentId}`} className="ui-btn ui-btn-secondary !py-1 !px-2.5 text-[12px] shrink-0">
                View final letter <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}

          {/* Error banner for actions */}
          {actions.actionError && (
            <div className="flex items-center gap-3 p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 rounded-xl text-rose-700 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {actions.actionError}
            </div>
          )}

          {/* ── Tabs ────────────────────────────────────────────────────── */}
          {visibleTabs.length > 0 && (
            <div>
              <div className="flex gap-1 p-1 bg-surface-raised rounded-xl w-fit mb-6 overflow-x-auto ui-scrollbar">
                {visibleTabs.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={cn(
                      'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all relative',
                      activeTab === key
                        ? 'bg-surface-card shadow-sm text-text-primary'
                        : 'text-text-muted hover:text-text-secondary',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                    {key === 'workflow' && headerChain?.status === 'IN_REVIEW' && (
                      <span className="absolute top-1 right-1.5 h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse" aria-label="Action pending" />
                    )}
                  </button>
                ))}
              </div>

              {/* ── Tab: Overview ──────────────────────────────────────── */}
              {activeTab === 'overview' && (
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <div className="xl:col-span-2 space-y-6">
                    {/* Active workflow banner */}
                    {activeWorkflow &&
                      (activeWorkflow['status'] as string) === 'ACTIVE' && (
                        <div className="flex items-start gap-4 p-5 bg-brand-50 dark:bg-brand-900/20 border border-brand-200 rounded-2xl">
                          <div className="p-2.5 bg-white rounded-xl shadow-sm shrink-0">
                            <Cpu className="h-5 w-5 text-brand-600 animate-pulse" />
                          </div>
                          <div className="flex-1">
                            <h3 className="text-sm font-bold text-brand-900 dark:text-brand-200 mb-1">
                              Active Workflow:{' '}
                              {String(
                                (
                                  activeWorkflow[
                                    'workflowDefinition'
                                  ] as Record<string, unknown>
                                )?.['name'] ?? '',
                              )}
                            </h3>
                            <p className="text-sm text-brand-700 dark:text-brand-300 mb-2">
                              Stage {String(activeWorkflow['currentStage'])}
                            </p>
                            <div className="w-full h-1.5 bg-brand-200 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-brand-600 transition-all"
                                style={{
                                  width: `${Math.min((Number(activeWorkflow['currentStage']) / 5) * 100, 100)}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}

                    <AIInsightsCard docId={typedDoc.id} />

                    <ExtractedTextCard
                      ocrStatus={typedDoc.ocrStatus}
                      ocrConfidenceScore={typedDoc.ocrConfidenceScore}
                      extractedText={latestVersion?.extractedText}
                    />

                    {/* Metadata */}
                    <div className="ui-card">
                      <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary mb-5">
                        <Info className="h-4 w-4 text-brand-600" />{' '}
                        Administrative Metadata
                      </h2>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-4">
                          <div>
                            <dt className="text-[10px] font-black text-text-muted uppercase tracking-widest mb-1">
                              Description
                            </dt>
                            <dd className="text-sm text-text-secondary leading-relaxed">
                              {typedDoc.metadata?.description || (
                                <span className="italic text-text-muted">
                                  No description
                                </span>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[10px] font-black text-text-muted uppercase tracking-widest mb-1">
                              Keywords
                            </dt>
                            <dd className="flex flex-wrap gap-1.5">
                              {typedDoc.metadata?.keywords ? (
                                typedDoc.metadata.keywords
                                  .split(',')
                                  .map((kw) => (
                                    <span
                                      key={kw}
                                      className="px-2 py-0.5 bg-brand-50 text-brand-700 rounded text-[11px] font-bold border border-brand-100"
                                    >
                                      {kw.trim()}
                                    </span>
                                  ))
                              ) : (
                                <span className="text-xs text-text-muted italic">
                                  No tags
                                </span>
                              )}
                            </dd>
                          </div>
                        </div>
                        <div className="space-y-3">
                          {[
                            [
                              'Owner',
                              `${typedDoc.owner?.firstName ?? ''} ${typedDoc.owner?.lastName ?? ''}`.trim() ||
                                '—',
                            ],
                            ['Department', typedDoc.department.name],
                            ['Document Type', typedDoc.documentType.name],
                            ['Retention Class', typedDoc.retentionClass],
                            ['Organisation Unit', typedDoc.organisationUnit],
                            ['Current Version', typedDoc.currentVersion],
                            [
                              'Created',
                              format(new Date(typedDoc.createdAt), 'PP'),
                            ],
                          ].map(([k, v]) => (
                            <div
                              key={k}
                              className="flex justify-between text-sm py-2 border-b border-border/50 last:border-0"
                            >
                              <dt className="text-text-muted font-medium">
                                {k}
                              </dt>
                              <dd className="text-text-primary font-semibold text-right max-w-[55%] truncate">
                                {v}
                              </dd>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Integrity sidebar */}
                  <div className="space-y-4">
                    <div className="bg-slate-900 rounded-2xl p-5 text-white">
                      <div className="flex items-center gap-2 mb-4">
                        <Shield className="h-5 w-5 text-indigo-400" />
                        <h2 className="text-xs font-black uppercase tracking-widest">
                          Integrity Pulse
                        </h2>
                      </div>
                      <div className="space-y-3">
                        <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/50">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                              Antivirus
                            </span>
                            {avStatus === 'quarantined' && (
                              <XCircle className="h-4 w-4 text-red-400" />
                            )}
                            {avStatus === 'scan_pending' && (
                              <RefreshCw className="h-4 w-4 text-slate-400 animate-spin" />
                            )}
                            {avStatus === 'unscanned' && (
                              <AlertTriangle className="h-4 w-4 text-amber-400" />
                            )}
                            {avStatus === 'clean' && (
                              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                            )}
                            {avStatus === 'unknown' && (
                              <AlertCircle className="h-4 w-4 text-slate-400" />
                            )}
                          </div>
                          <p className="text-xs text-slate-300">
                            {avStatus === 'quarantined' &&
                              'Threat detected — quarantined.'}
                            {avStatus === 'scan_pending' &&
                              'Scan in progress — large file awaiting antivirus clearance.'}
                            {avStatus === 'unscanned' &&
                              'Not scanned — allowed through, flagged for review.'}
                            {avStatus === 'clean' && 'No threats detected.'}
                            {avStatus === 'unknown' && 'Scan status unavailable.'}
                          </p>
                        </div>
                        <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/50">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                              OCR
                            </span>
                            <span
                              className={cn(
                                'text-[10px] font-bold px-1.5 py-0.5 rounded',
                                typedDoc.ocrStatus === 'COMPLETED'
                                  ? 'bg-emerald-800 text-emerald-300'
                                  : typedDoc.ocrStatus === 'FAILED'
                                    ? 'bg-red-800 text-red-300'
                                    : 'bg-slate-700 text-slate-400',
                              )}
                            >
                              {typedDoc.ocrStatus ?? 'PENDING'}
                            </span>
                          </div>
                          <div className="flex items-end justify-between">
                            <span className="text-xl font-black">
                              {Math.round(typedDoc.ocrConfidenceScore ?? 0)}%
                            </span>
                            <span className="text-[10px] text-slate-400 uppercase">
                              Confidence
                            </span>
                          </div>
                          <div className="mt-2 w-full bg-slate-700 rounded-full h-1 overflow-hidden">
                            <div
                              className="bg-indigo-500 h-full rounded-full"
                              style={{
                                width: `${typedDoc.ocrConfidenceScore ?? 0}%`,
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Tab: File & Preview ────────────────────────────────── */}
              {activeTab === 'preview' && (
                <div className="ui-card">
                  <StorageFiles doc={typedDoc} />
                </div>
              )}

              {/* ── Tab: Comments ──────────────────────────────────────── */}
              {activeTab === 'comments' && (
                <div className="max-w-3xl">
                  <CommentsPanel documentId={id} />
                </div>
              )}

              {/* ── Tab: Versions ──────────────────────────────────────── */}
              {activeTab === 'versions' && (
                <div className="ui-card overflow-hidden p-0">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                      <History className="h-4 w-4 text-brand-600" /> Version
                      History
                    </h2>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-text-muted bg-surface-raised px-2 py-0.5 rounded">
                        {typedDoc.versions?.length ?? 0} versions
                      </span>
                      {(typedDoc.versions?.length ?? 0) >= 2 && (
                        <button
                          onClick={() => setShowVersionDiff(true)}
                          className="ui-btn ui-btn-secondary text-xs"
                        >
                          Compare versions
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="overflow-x-auto ui-scrollbar">
                    <table className="min-w-full">
                      <thead className="bg-surface-raised border-b border-border">
                        <tr>
                          {[
                            'Version',
                            'Change Summary',
                            'Author',
                            'SHA-256',
                            'Date',
                          ].map((h) => (
                            <th
                              key={h}
                              className="px-5 py-3 text-left text-[10px] font-black text-text-muted uppercase tracking-widest"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(typedDoc.versions ?? []).map((v, idx) => (
                          <tr key={v.id} className="ui-table-row">
                            <td className="px-5 py-3.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    'h-2 w-2 rounded-full',
                                    idx === 0 ? 'bg-brand-600' : 'bg-border',
                                  )}
                                />
                                <span
                                  className={cn(
                                    'text-sm font-bold',
                                    idx === 0
                                      ? 'text-text-primary'
                                      : 'text-text-muted',
                                  )}
                                >
                                  {v.versionNumber}
                                </span>
                                <ScanStatusBadge
                                  status={(v as { avScanStatus?: string | null }).avScanStatus}
                                />
                                {idx === 0 && (
                                  <span className="text-[9px] font-bold bg-brand-600 text-white px-1.5 py-0.5 rounded uppercase">
                                    Latest
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-5 py-3.5 text-sm text-text-secondary max-w-xs truncate">
                              {v.changeSummary}
                            </td>
                            <td className="px-5 py-3.5 text-xs font-mono text-text-muted">
                              {v.authorId?.slice(0, 8)}…
                            </td>
                            <td className="px-5 py-3.5">
                              <code className="text-[10px] font-mono bg-surface-raised px-2 py-1 rounded text-text-muted">
                                {v.sha256Hash?.slice(0, 16)}…
                              </code>
                            </td>
                            <td className="px-5 py-3.5 text-sm text-text-muted whitespace-nowrap">
                              <div className="flex items-center justify-between gap-3">
                                <span>{format(new Date(v.createdAt), 'MMM d, yyyy')}</span>
                                {idx !== 0 && can(PERMISSIONS.DOCUMENT_UPLOAD) && (
                                  <button
                                    onClick={() => {
                                      if (confirm(`Restore version ${v.versionNumber} as a new latest version? The current content is preserved in history.`)) {
                                        actions.rollback(v.id);
                                      }
                                    }}
                                    disabled={actions.loading === 'rollback'}
                                    className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:text-brand-700 disabled:opacity-50"
                                  >
                                    <History className="h-3.5 w-3.5" /> Restore
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                        {(!typedDoc.versions ||
                          typedDoc.versions.length === 0) && (
                          <tr>
                            <td
                              colSpan={5}
                              className="px-5 py-10 text-center text-sm text-text-muted"
                            >
                              No versions found.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Tab: Workflow ──────────────────────────────────────── */}
              {activeTab === 'workflow' && (
                <>
                {/* Unified approval engine (SYSTEM-DECISIONS.md D1–D7): submit,
                    chain stepper, decisions, audit stage. Letter-backed CORR
                    documents never appear in this engine at all (letters run
                    their own separate chain) — check that first so a fully
                    approved/signed/archived letter doesn't render the
                    generic card's misleading "not submitted yet" empty
                    state. */}
                {linkedLetter ? (
                  <CorrespondenceApprovalChain letter={linkedLetter} />
                ) : typedDoc.documentType.requiresApproval === false ? (
                  <div className="ui-card mt-4">
                    <p className="text-[12px] font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                      Approval chain
                    </p>
                    <p className="text-sm text-text-muted">
                      This document type does not require approval — use the Publish / Discard buttons above instead of submitting for approval.
                    </p>
                  </div>
                ) : (
                  <>
                    {typedDoc.formInstanceId && (
                      formPreviewUrl ? (
                        <div className="ui-card mt-4 p-0 overflow-hidden">
                          <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
                            <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>PDF preview</p>
                            <button
                              onClick={() => {
                                URL.revokeObjectURL(formPreviewUrl);
                                setFormPreviewUrl(null);
                              }}
                              className="text-[12px]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              Hide
                            </button>
                          </div>
                          <div className="max-h-[720px] overflow-y-auto p-2">
                            <PdfBlobPreview blobUrl={formPreviewUrl} />
                          </div>
                        </div>
                      ) : (
                        <div className="ui-card mt-4 flex items-center justify-between">
                          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                            See the generated form before deciding.
                          </p>
                          <button onClick={loadFormPreview} className="ui-btn ui-btn-secondary !py-1.5 text-xs">
                            Preview
                          </button>
                        </div>
                      )
                    )}
                    <ApprovalChainCard
                      documentId={id}
                      documentStatus={String(typedDoc.status ?? '')}
                      ownerId={(typedDoc.ownerId as string) ?? null}
                      auditPolicy={((typedDoc.documentType as Record<string, unknown>)?.auditPolicy as 'required' | 'optional' | 'never') ?? 'never'}
                      itemType={typedDoc.formInstanceId ? 'FORM_INSTANCE' : 'DOCUMENT'}
                      itemId={typedDoc.formInstanceId ?? id}
                      signatureRequests={typedDoc.signatureRequests}
                      departmentId={typedDoc.department?.id ?? null}
                    />
                  </>
                )}
                {/* Live-verified UX gap (2026-08-27 re-audit): this legacy
                    (pre-unified-engine) workflow_instances panel rendered
                    unconditionally, so on every single document it showed
                    "No active workflow on this document" directly underneath
                    the real Approval Chain card above — even while that card
                    displayed an active, in-progress chain. Two "workflow"
                    panels giving contradictory signals on the same tab. Only
                    render it when a legacy instance actually exists. */}
                {activeWorkflow && (
                <div className="ui-card mt-4">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary mb-4">
                    <Cpu className="h-4 w-4 text-brand-600" /> Workflow Status
                  </h2>
                  {activeWorkflow ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        {[
                          [
                            'Definition',
                            String(
                              (
                                activeWorkflow['workflowDefinition'] as Record<
                                  string,
                                  unknown
                                >
                              )?.['name'] ?? '—',
                            ),
                          ],
                          ['Status', String(activeWorkflow['status'] ?? '—')],
                          [
                            'Current Stage',
                            String(activeWorkflow['currentStage'] ?? '—'),
                          ],
                          [
                            'Initiated by',
                            (() => {
                              const initiator = activeWorkflow['initiator'] as
                                | { firstName?: string; lastName?: string }
                                | undefined;
                              return initiator ? `${initiator.firstName ?? ''} ${initiator.lastName ?? ''}`.trim() : '—';
                            })(),
                          ],
                          [
                            'Initiated',
                            activeWorkflow['createdAt']
                              ? format(
                                  new Date(String(activeWorkflow['createdAt'])),
                                  'PPp',
                                )
                              : '—',
                          ],
                        ].map(([k, v]) => (
                          <div
                            key={k}
                            className="p-3 bg-surface-raised rounded-xl"
                          >
                            <dt className="text-[10px] font-black text-text-muted uppercase tracking-wider mb-1">
                              {k}
                            </dt>
                            <dd className="text-sm font-semibold text-text-primary">
                              {v}
                            </dd>
                          </div>
                        ))}
                      </div>
                      <div>
                        <h3 className="text-xs font-black text-text-muted uppercase tracking-wider mb-2">
                          Stage History
                        </h3>
                        <WorkflowStageTimeline instanceId={String(activeWorkflow['id'])} />
                      </div>
                    </div>
                  ) : (
                    <div className="py-10 text-center">
                      <Cpu className="h-10 w-10 text-text-muted mx-auto mb-3" />
                      <p className="text-sm text-text-muted">
                        No active workflow on this document.
                      </p>
                    </div>
                  )}
                </div>
                )}
                </>
              )}

              {/* ── Tab: Audit Trail ───────────────────────────────────── */}
              {activeTab === 'audit' && (
                <div className="ui-card overflow-hidden p-0">
                  <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
                    <ShieldCheck className="h-4 w-4 text-brand-600" />
                    <h2 className="text-sm font-bold text-text-primary">
                      Document Audit Events
                    </h2>
                    <span className="ml-auto text-xs text-text-muted font-mono">
                      {auditList.length} entries
                    </span>
                  </div>
                  {auditList.length === 0 ? (
                    <div className="py-10 text-center">
                      <ShieldCheck className="h-10 w-10 text-text-muted mx-auto mb-3" />
                      <p className="text-sm text-text-muted">
                        No audit events for this document.
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border/50 max-h-96 overflow-y-auto ui-scrollbar">
                      {(auditList as Record<string, unknown>[]).map((log) => {
                        const actor = log['actor'] as { firstName?: string; lastName?: string; email?: string } | null;
                        const actorName = actor ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() : '';
                        return (
                        <div
                          key={String(log['id'])}
                          className="px-5 py-3 flex items-center gap-4"
                        >
                          <span className="text-xs text-text-muted whitespace-nowrap font-mono w-28 shrink-0">
                            {format(
                              new Date(String(log['timestamp'])),
                              'MMM d HH:mm',
                            )}
                          </span>
                          <span className="text-xs font-bold bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300 px-2 py-0.5 rounded border border-brand-100 shrink-0">
                            {String(log['eventType'] ?? '')}
                          </span>
                          <span className="text-xs font-semibold text-text-primary whitespace-nowrap shrink-0" title={actor?.email ?? ''}>
                            {actorName || (log['userRole'] ? String(log['userRole']) : 'System')}
                          </span>
                          {Boolean(log['previousState']) &&
                            Boolean(log['newState']) && (
                              <span className="text-xs text-text-muted flex items-center gap-1">
                                {String(log['previousState'])}
                                <ChevronRight className="h-3 w-3" />
                                {String(log['newState'])}
                              </span>
                            )}
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── Tab: Governance ────────────────────────────────────── */}
              {activeTab === 'governance' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Signatures */}
                  <div className="ui-card">
                    <h3 className="text-sm font-bold text-text-primary mb-4 flex items-center gap-2">
                      <Pen className="h-4 w-4 text-brand-600" /> Digital
                      Signatures
                    </h3>
                    {(typedDoc.signatureRequests?.length ?? 0) > 0 ? (
                      <div className="space-y-3">
                        {typedDoc.signatureRequests?.map((req) => (
                          <div
                            key={req.id}
                            className="p-3 rounded-xl border"
                            style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                          >
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <StatusBadge status={req.status.toUpperCase()} />
                              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{req.orderingMode}</span>
                            </div>
                            <div className="space-y-1">
                              {(req.recipients ?? []).map((rec) => (
                                <div key={rec.id} className="flex items-center gap-2 text-sm">
                                  {rec.status === 'signed' ? (
                                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                                  ) : rec.status === 'declined' ? (
                                    <XCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />
                                  ) : (
                                    <Pen className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                                  )}
                                  <span className="flex-1 truncate">
                                    {rec.orderIndex + 1}. {rec.name}{' '}
                                    <span style={{ color: 'var(--text-muted)' }}>{rec.email}</span>
                                  </span>
                                  <StatusBadge status={rec.status.toUpperCase()} />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="py-6 text-center">
                        <p className="text-sm text-text-muted mb-4">
                          No signatures applied.
                        </p>
                        <PermissionGate permission={PERMISSIONS.SIGNING_MANAGE}>
                          <button
                            onClick={() => { router.push(`/dashboard/signing?documentId=${id}`); }}
                            className="ui-btn ui-btn-primary text-xs"
                          >
                            <Pen className="h-3.5 w-3.5" /> Initiate Signing
                          </button>
                        </PermissionGate>
                      </div>
                    )}
                  </div>

                  {/* Legal Hold */}
                  <PermissionGate permission={PERMISSIONS.LEGAL_HOLD_READ}>
                    <div className="ui-card">
                      <h3 className="text-sm font-bold text-text-primary mb-4 flex items-center gap-2">
                        <Gavel className="h-4 w-4 text-brand-600" /> Legal Hold
                        Status
                      </h3>
                      {isOnHold ? (
                        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 rounded-xl">
                          <p className="text-sm font-bold text-red-700 flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4" /> Document is
                            under legal hold
                          </p>
                          <p className="text-xs text-red-600 mt-1">
                            Archival, disposal, and modification are blocked.
                          </p>
                          <PermissionGate
                            permission={PERMISSIONS.LEGAL_HOLD_MANAGE}
                          >
                            <button
                              onClick={() => { router.push('/operations?panel=legalHold'); }}
                              title="Holds are released from the Legal Holds console (closure reference + reason required)"
                              className="mt-3 ui-btn ui-btn-danger text-xs"
                            >
                              Release Hold
                            </button>
                          </PermissionGate>
                        </div>
                      ) : (
                        <div className="py-6 text-center">
                          <p className="text-sm text-text-muted mb-4">
                            No legal hold active.
                          </p>
                          <PermissionGate
                            permission={PERMISSIONS.LEGAL_HOLD_MANAGE}
                          >
                            <button
                              onClick={() => { router.push('/operations?panel=legalHold'); }}
                              title="Holds are created from the Legal Holds console (case reference + legal basis required)"
                              className="ui-btn ui-btn-secondary text-xs"
                            >
                              <Gavel className="h-3.5 w-3.5" /> Place Hold
                            </button>
                          </PermissionGate>
                        </div>
                      )}
                    </div>
                  </PermissionGate>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showCheckout && (
        <CheckoutModal
          onConfirm={(note) => {
            actions.checkout(note);
            setShowCheckout(false);
          }}
          onClose={() => setShowCheckout(false)}
          loading={actions.loading === 'checkout'}
        />
      )}
      {showUpload && (
        <VersionUploadModal
          docId={typedDoc.id}
          onClose={() => setShowUpload(false)}
        />
      )}
      {showAddToBundle && (
        <AddToBundleModal
          documentId={typedDoc.id}
          documentTitle={typedDoc.title}
          onClose={() => setShowAddToBundle(false)}
        />
      )}
      {showVersionDiff && (
        <VersionDiffModal
          documentId={typedDoc.id}
          versions={(typedDoc.versions ?? []).map((v) => ({ id: v.id, versionNumber: v.versionNumber }))}
          onClose={() => setShowVersionDiff(false)}
        />
      )}
      {forceUnlockModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setForceUnlockModalOpen(false)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="force-unlock-modal-title">
            <h3 id="force-unlock-modal-title" className="text-sm font-bold mb-2">Force unlock</h3>
            <p className="text-xs text-red-600 mb-3">Admin recovery for a stuck lock held by someone else. A reason is required and recorded on the audit log.</p>
            <textarea
              value={forceUnlockReason}
              onChange={(e) => setForceUnlockReason(e.target.value)}
              placeholder="Reason for force-unlocking…"
              className="ui-input w-full min-h-[80px] text-sm mb-3"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setForceUnlockModalOpen(false)} className="ui-btn ui-btn-secondary text-xs">Cancel</button>
              <button
                disabled={!!actions.loading || !forceUnlockReason.trim()}
                onClick={() => { actions.forceUnlock(forceUnlockReason.trim()); setForceUnlockModalOpen(false); }}
                className="ui-btn ui-btn-danger text-xs"
              >
                Force Unlock
              </button>
            </div>
          </div>
        </div>
      )}
      {discardConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setDiscardConfirmOpen(false)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="discard-draft-modal-title">
            <h3 id="discard-draft-modal-title" className="text-sm font-bold mb-2">Discard this draft?</h3>
            <p className="text-xs text-text-muted mb-3">It will be cancelled and can no longer be submitted or published.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDiscardConfirmOpen(false)} className="ui-btn ui-btn-secondary text-xs">Back</button>
              <button
                disabled={!!actions.loading}
                onClick={() => { actions.changeStatus('CANCELLED'); setDiscardConfirmOpen(false); }}
                className="ui-btn ui-btn-danger text-xs"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
      {deletePermanentlyConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setDeletePermanentlyConfirmOpen(false)} role="presentation" />
          <div className="relative ui-card max-w-md w-full" role="dialog" aria-modal="true" aria-labelledby="delete-permanently-modal-title">
            <h3 id="delete-permanently-modal-title" className="text-sm font-bold mb-2">Permanently delete this draft?</h3>
            <p className="text-xs text-text-muted mb-3">
              The file, its database record, and any versions are destroyed immediately — this skips Trash
              entirely, so there is no 30-day recovery window and nothing to restore afterward.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletePermanentlyConfirmOpen(false)} className="ui-btn ui-btn-secondary text-xs">Back</button>
              <button
                disabled={!!actions.loading}
                onClick={async () => {
                  try {
                    await actions.deletePermanently();
                    setDeletePermanentlyConfirmOpen(false);
                    toast.success('Draft permanently deleted');
                    router.push('/dashboard/files');
                  } catch {
                    // actions.deletePermanently already set actionError; keep the modal
                    // open so the error banner behind it stays visible on close.
                  }
                }}
                className="ui-btn ui-btn-danger text-xs"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
