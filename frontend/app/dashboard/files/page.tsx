'use client';

import { useState } from 'react';
import { format } from 'date-fns';

function safeDate(value: unknown, fmt: string): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Files, Lock, CheckCircle2, Download, Eye, Archive, Trash2, X, RefreshCw, Paperclip, FolderInput, Tags, ShieldPlus, Layers } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { apiClient, apiClientBlob } from '../../../shared/lib/apiClient';
import { downloadDocumentUrl, listDocuments } from '../../../features/documents/api';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { DataTable } from '../../../shared/components/DataTable';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { FileTypeIcon } from '../../../shared/components/FileTypeIcon';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { DocumentPreviewModal } from '../../../shared/components/DocumentPreviewModal';
import { Modal } from '../../../shared/components/Modal';
import { AddToBundleModal } from '../../../features/bundles/AddToBundleModal';
import { CreateBundleModal } from '../../../features/bundles/CreateBundleModal';
import { useUIStore } from '../../../state/ui.store';
import { useAuthStore } from '../../../state/auth.store';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../../shared/lib/permissions';

type Tab = 'mine' | 'checkedout';

// Statuses with a valid ->ARCHIVED edge in DocumentStateMachine.ts's
// transition graph — offering Archive outside this set always 409s
// (most commonly DRAFT, which has no ->ARCHIVED edge at all; see Discard
// below for the actual way to get rid of an unwanted draft).
// FIX (platform audit finding 2026-08-14, follow-up): this set included
// QUARANTINED, but DocumentStateMachine.ts's real transition map is
// `QUARANTINED: ["ACTIVE", "CANCELLED"]` — no ->ARCHIVED edge at all, so it
// never actually belonged in a set whose own comment claims to mirror that
// graph. ScanWorker.ts sets a document QUARANTINED when an async virus scan
// (>100MB uploads) flags it, and it isn't excluded from the "My Documents"/
// "Checked Out" lists, so this was reachable: selecting one in a bulk
// Archive alongside ordinary documents let the button enable, then the
// batch partially failed with a confusing "Invalid document transition:
// QUARANTINED -> ARCHIVED" — the frontend should never have offered it.
const ARCHIVABLE_STATUSES = new Set(['ACTIVE', 'SIGNED', 'APPROVED', 'AUDITED', 'SUPERSEDED']);

// 15/page, matching the project-wide pagination convention (see
// documents.routes.ts skip/take + shared/components/ui/PaginationControls.tsx).
const FILES_PAGE_SIZE = 15;

export default function FilesPage() {
  const router = useRouter();
  const { userId } = useAuthStore();
  const { can } = usePermissions();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [tab, setTab] = useState<Tab>('mine');
  const [minePage, setMinePage] = useState(1);
  const [checkedOutPage, setCheckedOutPage] = useState(1);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; title: string; mimeType: string; documentName: string } | null>(null);
  const [bundleDoc, setBundleDoc] = useState<{ id: string; title: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  // "My Documents" — real backend pagination (15/page), filtered server-side
  // by ownerId (documents.routes.ts) instead of client-filtering the shared
  // useDocuments() top-50 feed, which could miss older owned documents once a
  // user has more than 50 documents visible in their tenant-wide scope.
  const {
    data: minePageData,
    isLoading: mineLoading,
    isError: mineError,
    error: mineErrorObj,
    refetch: refetchMine,
  } = useQuery({
    queryKey: ['files-mine', userId, minePage],
    queryFn: () =>
      listDocuments((minePage - 1) * FILES_PAGE_SIZE, FILES_PAGE_SIZE, { ownerId: userId! }),
    enabled: tab === 'mine' && Boolean(userId),
    staleTime: 30_000,
    // Filing can occur on another repository surface (including bundle
    // compilation). A direct return to My Files must not reuse a fresh-but-
    // pre-filing page from this client session.
    refetchOnMount: 'always',
  });
  const mine = minePageData?.data ?? [];
  const mineTotal = minePageData?.total ?? mine.length;
  const mineTotalPages = Math.max(1, Math.ceil(mineTotal / FILES_PAGE_SIZE));

  // "Checked Out" — real backend pagination (15/page) via the new checkedOut
  // filter (documents.routes.ts). This replaces the old shared useDocuments()
  // top-50 feed, which could never populate at all: the list endpoint's include
  // set didn't attach checkout data for LIST queries, so `!!d.checkout` was
  // always false. The backend now includes the checkout row (INNER JOIN when
  // filtered) so the tab shows every checked-out document, paged.
  const {
    data: checkedOutPageData,
    isLoading: checkedOutLoading,
    isError: checkedOutError,
    error: checkedOutErrorObj,
    refetch: refetchCheckedOut,
  } = useQuery({
    queryKey: ['files-checked-out', checkedOutPage],
    queryFn: () =>
      listDocuments((checkedOutPage - 1) * FILES_PAGE_SIZE, FILES_PAGE_SIZE, { checkedOut: true }),
    enabled: tab === 'checkedout',
    staleTime: 30_000,
  });
  const checkedOut = checkedOutPageData?.data ?? [];
  const checkedOutTotal = checkedOutPageData?.total ?? checkedOut.length;
  const checkedOutTotalPages = Math.max(1, Math.ceil(checkedOutTotal / FILES_PAGE_SIZE));

  const displayed = tab === 'mine' ? mine : checkedOut;
  const isLoading = tab === 'mine' ? mineLoading : checkedOutLoading;
  const isError = tab === 'mine' ? mineError : checkedOutError;
  const activeError = tab === 'mine' ? mineErrorObj : checkedOutErrorObj;
  const retryActive = tab === 'mine' ? refetchMine : refetchCheckedOut;

  const switchTab = (key: Tab) => {
    setTab(key);
    setSelected(new Set());
    setMinePage(1);
    setCheckedOutPage(1);
  };

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allSelected = displayed.length > 0 && displayed.every((d: any) => selected.has(d.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(displayed.map((d: any) => d.id)));

  const selectedRows = displayed.filter((d: any) => selected.has(d.id));
  const allSelectedArchivable = selectedRows.length > 0 && selectedRows.every((d: any) => ARCHIVABLE_STATUSES.has(d.status));
  const allSelectedDraft = selectedRows.length > 0 && selectedRows.every((d: any) => d.status === 'DRAFT');

  const bulk = useMutation({
    mutationFn: ({ operation, params }: { operation: 'archive' | 'trash' | 'move' | 'tag' | 'grant-acl' | 'status' | 'delete-permanent'; params?: Record<string, unknown> }) =>
      apiClient<{
        summary: { total: number; succeeded: number; failed: number };
        results: Array<{ documentId: string; success: boolean; error?: string }>;
      }>(
        '/documents/bulk',
        { method: 'POST', body: JSON.stringify({ operation, documentIds: Array.from(selected), params }) },
      ),
    onSuccess: (res, { operation }) => {
      const { succeeded, failed } = res.summary;
      const verb = { archive: 'Archived', trash: 'Trashed', move: 'Moved', tag: 'Tagged', 'grant-acl': 'Granted access to', status: 'Updated', 'delete-permanent': 'Permanently deleted' }[operation];
      if (failed === 0) {
        toast.success(`${verb} ${succeeded} document${succeeded === 1 ? '' : 's'}`);
      } else {
        // Surface the real per-document reason instead of only a count — a bare
        // "X succeeded, Y failed" leaves the user no way to tell WHY (e.g. trying
        // to archive a document still in Draft, which always 409s).
        const failures = res.results.filter((r) => !r.success);
        const titleFor = (id: string) => displayed.find((d: any) => d.id === id)?.title ?? id;
        toast.error(
          <span className="text-sm leading-snug">
            {succeeded} of {res.summary.total} succeeded.
            <ul className="mt-1 list-disc pl-4">
              {failures.slice(0, 5).map((f) => (
                <li key={f.documentId}>
                  <strong>{titleFor(f.documentId)}</strong>: {f.error ?? 'failed'}
                </li>
              ))}
            </ul>
            {failures.length > 5 && <span>…and {failures.length - 5} more</span>}
          </span>,
          { duration: 10000 },
        );
      }
      setSelected(new Set());
      setBulkModal(null);
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['files-mine'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Bulk action failed'),
  });

  // Modal state + inputs for the parameterized bulk ops.
  const [bulkModal, setBulkModal] = useState<'move' | 'tag' | 'grant-acl' | null>(null);
  const [confirmDeleteDrafts, setConfirmDeleteDrafts] = useState(false);
  const [moveFolderId, setMoveFolderId] = useState('');
  const [tagKeywords, setTagKeywords] = useState('');
  const [grantForm, setGrantForm] = useState({ principalType: 'user' as 'user' | 'role', principalId: '', permission: 'document:read' });

  const { data: folderOptions } = useQuery({
    queryKey: ['folders', 'bulk-move-picker'],
    queryFn: () => apiClient<{ data: Array<{ id: string; name: string; path?: string }> }>('/folders'),
    enabled: bulkModal === 'move',
    staleTime: 60_000,
  });
  const { data: principalOptions } = useQuery({
    queryKey: [grantForm.principalType === 'user' ? 'users' : 'roles', 'bulk-grant-picker'],
    queryFn: () =>
      apiClient<{ data: Array<{ id: string; name?: string; firstName?: string; lastName?: string; email?: string }> }>(
        grantForm.principalType === 'user' ? '/users' : '/roles',
      ),
    enabled: bulkModal === 'grant-acl',
    staleTime: 60_000,
  });

  const canArchive = can(PERMISSIONS.DOCUMENT_ARCHIVE);
  const canMoveTag = can(PERMISSIONS.DOCUMENT_UPLOAD);
  const canGrant = can(PERMISSIONS.ACL_MANAGE);
  // Bundle endpoints (bundles.routes.ts) only require document:read — anyone
  // who can see these rows can stitch them into a bundle.
  const canBundle = can(PERMISSIONS.DOCUMENT_READ);
  const canBulk = canArchive || canMoveTag || canGrant || canBundle;
  const [showBundleModal, setShowBundleModal] = useState(false);

  const columns = [
    ...(canBulk
      ? [
          {
            key: 'select',
            label: '',
            mobileHidden: true,
            render: (_value: unknown, row: any) => (
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggleRow(row.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${row.title}`}
                className="h-4 w-4 rounded border-border accent-brand-600 cursor-pointer"
              />
            ),
          },
        ]
      : []),
    {
      key: 'type',
      label: '',
      render: (_value: unknown, row: any) => {
        if (!row) return null;
        const mimeType =
          row?.versions?.[0]?.mimeType || row?.versions?.[0]?.mime_type || '';
        return <FileTypeIcon mimeType={mimeType} size={18} />;
      },
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      render: (_value: unknown, row: any) => (
        <>
          <Link
            href={`/dashboard/documents/${row.id}`}
            className="font-semibold text-text-primary hover:text-brand-600"
          >
            {row.title}
          </Link>
          {row.currentVersion && (
            <span className="text-[10px] font-mono text-text-muted ml-1">
              v{row.currentVersion}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (_value: unknown, row: any) => (
        <StatusBadge status={row.status} />
      ),
    },
    {
      key: 'classification',
      label: 'Classification',
      mobileLabel: 'Class',
      render: (_value: unknown, row: any) => {
        const cls = row.securityClassification;
        const colors: Record<string, string> = {
          PUBLIC: 'bg-green-50 text-green-700',
          INTERNAL: 'bg-blue-50 text-blue-700',
          CONFIDENTIAL: 'bg-amber-50 text-amber-700',
          RESTRICTED: 'bg-red-50 text-red-700',
        };
        if (!cls) return null;
        return (
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${colors[cls] ?? 'bg-slate-100 text-slate-600'}`}
          >
            {cls}
          </span>
        );
      },
    },
    {
      key: 'updated',
      label: 'Modified',
      sortable: true,
      render: (_value: unknown, row: any) =>
        safeDate(row.updatedAt, 'MMM d, yyyy'),
    },
    {
      key: 'actions',
      label: '',
      render: (_value: unknown, row: any) => (
        <div className="flex items-center gap-2">
          {can(PERMISSIONS.DOCUMENT_READ) && (
            <button
              className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              title="Preview"
              onClick={() => setPreviewDoc({ id: row.id, title: row.title, mimeType: row.versions?.[0]?.mimeType || '', documentName: row.documentName })}
            >
              <Eye className="h-4 w-4" />
            </button>
          )}
          {can(PERMISSIONS.DOCUMENT_READ) && (
            <button
              className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
              title="Download"
              onClick={async () => {
                try {
                  const blob = await apiClientBlob(downloadDocumentUrl(row.id));
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = row.documentName ?? row.title;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (err: unknown) {
                  toast.error(err instanceof Error ? err.message : 'Download failed');
                }
              }}
            >
              <Download className="h-4 w-4" />
            </button>
          )}
          {can(PERMISSIONS.DOCUMENT_READ) && (
            <button
              className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
              title="Add to bundle"
              onClick={() => setBundleDoc({ id: row.id, title: row.title })}
            >
              <Paperclip className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  const TABS: {
    key: Tab;
    label: string;
    icon: React.ElementType;
    count: number;
  }[] = [
    { key: 'mine', label: 'My Documents', icon: Files, count: mineTotal },
    {
      key: 'checkedout',
      label: 'Checked Out',
      icon: Lock,
      count: checkedOut.length,
    },
  ];

  return (
    <>
      <TopBar
        title="My Files"
        breadcrumbs={[
          { label: 'Repository', href: '/dashboard' },
          { label: 'Files' },
        ]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader
          title="My Files"
          subtitle="Documents you own or have checked out"
        />

        <div className="flex gap-1 p-1 bg-surface-raised rounded-xl mb-6 w-fit">
          {TABS.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              onClick={() => switchTab(key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                tab === key
                  ? 'bg-surface-card shadow-sm text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  tab === key
                    ? 'bg-brand-100 text-brand-700'
                    : 'bg-slate-200 text-slate-500'
                }`}
              >
                {count}
              </span>
            </button>
          ))}
        </div>

        {isError && (
          <div className="ui-card mb-6 p-0">
            <ErrorState error={activeError} title="Couldn't load files" onRetry={() => retryActive()} />
          </div>
        )}

        {canBulk && selected.size > 0 && (
          <div className="flex items-center gap-3 mb-4 px-4 py-2.5 rounded-xl bg-brand-50 border border-brand-200 dark:bg-brand-500/15 dark:border-brand-500/30 animate-fade-in">
            <button
              onClick={toggleAll}
              className="text-xs font-semibold text-brand-700 hover:underline"
            >
              {allSelected ? 'Deselect all' : `Select all ${displayed.length}`}
            </button>
            <span className="text-sm font-semibold text-text-primary">
              {selected.size} selected
            </span>
            <div className="ml-auto flex items-center gap-2">
              {canMoveTag && (
                <button onClick={() => { setMoveFolderId(''); setBulkModal('move'); }} disabled={bulk.isPending} className="ui-btn ui-btn-secondary text-xs">
                  <FolderInput className="h-3.5 w-3.5" /> Move
                </button>
              )}
              {canMoveTag && (
                <button onClick={() => { setTagKeywords(''); setBulkModal('tag'); }} disabled={bulk.isPending} className="ui-btn ui-btn-secondary text-xs">
                  <Tags className="h-3.5 w-3.5" /> Tag
                </button>
              )}
              {canGrant && (
                <button onClick={() => { setGrantForm({ principalType: 'user', principalId: '', permission: 'document:read' }); setBulkModal('grant-acl'); }} disabled={bulk.isPending} className="ui-btn ui-btn-secondary text-xs">
                  <ShieldPlus className="h-3.5 w-3.5" /> Grant access
                </button>
              )}
              {canBundle && (
                <button onClick={() => setShowBundleModal(true)} disabled={bulk.isPending} className="ui-btn ui-btn-secondary text-xs">
                  <Layers className="h-3.5 w-3.5" /> Bundle
                </button>
              )}
              {canArchive && (
                <button
                  onClick={() => bulk.mutate({ operation: 'archive' })}
                  disabled={bulk.isPending || !allSelectedArchivable}
                  title={allSelectedArchivable ? undefined : 'Only Active, Signed, Approved, Audited, Superseded, or Quarantined documents can be archived — a Draft must be Discarded instead'}
                  className="ui-btn ui-btn-secondary text-xs"
                >
                  {bulk.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                  Archive
                </button>
              )}
              {canMoveTag && allSelectedDraft && (
                <button
                  onClick={() => bulk.mutate({ operation: 'status', params: { status: 'CANCELLED' } })}
                  disabled={bulk.isPending}
                  title="Discard these drafts — they were never submitted"
                  className="ui-btn ui-btn-danger text-xs"
                >
                  <X className="h-3.5 w-3.5" />
                  Discard
                </button>
              )}
              {canArchive && (
                <button
                  onClick={() => bulk.mutate({ operation: 'trash' })}
                  disabled={bulk.isPending}
                  className="ui-btn ui-btn-danger text-xs"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Trash
                </button>
              )}
              {canMoveTag && allSelectedDraft && (
                <button
                  onClick={() => setConfirmDeleteDrafts(true)}
                  disabled={bulk.isPending}
                  title="Permanently delete these drafts right now — skips Trash entirely and cannot be undone"
                  className="ui-btn ui-btn-danger text-xs"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete Permanently
                </button>
              )}
              <button
                onClick={() => setSelected(new Set())}
                className="ui-btn ui-btn-ghost ui-btn-icon"
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        <DataTable
          columns={columns}
          data={displayed}
          isLoading={isLoading}
          mobileTitleKey="title"
          mobileSubtitleKey="updated"
          emptyState={
            <EmptyState
              icon={tab === 'mine' ? Files : CheckCircle2}
              title={
                tab === 'mine' ? 'No documents yet' : 'Nothing checked out'
              }
              description={
                tab === 'mine'
                  ? 'Documents you upload will appear here.'
                  : 'You have no documents currently checked out.'
              }
              action={
                tab === 'mine' && can(PERMISSIONS.DOCUMENT_UPLOAD)
                  ? {
                      label: 'Upload a document',
                      onClick: () => router.push('/dashboard/upload'),
                    }
                  : undefined
              }
            />
          }
        />
        {tab === 'mine' && mineTotal > FILES_PAGE_SIZE && (
          <PaginationControls
            page={minePage}
            onPageChange={setMinePage}
            hasPrevious={minePage > 1}
            hasNext={minePage * FILES_PAGE_SIZE < mineTotal}
            totalPages={mineTotalPages}
            isLoading={mineLoading}
          />
        )}
        {tab === 'checkedout' && checkedOutTotal > FILES_PAGE_SIZE && (
          <PaginationControls
            page={checkedOutPage}
            onPageChange={setCheckedOutPage}
            hasPrevious={checkedOutPage > 1}
            hasNext={checkedOutPage * FILES_PAGE_SIZE < checkedOutTotal}
            totalPages={checkedOutTotalPages}
            isLoading={checkedOutLoading}
          />
        )}
      </div>
      <DocumentPreviewModal
        documentId={previewDoc?.id ?? null}
        title={previewDoc?.title ?? ''}
        mimeType={previewDoc?.mimeType ?? ''}
        documentName={previewDoc?.documentName ?? ''}
        onClose={() => setPreviewDoc(null)}
      />
      {bundleDoc && (
        <AddToBundleModal
          documentId={bundleDoc.id}
          documentTitle={bundleDoc.title}
          onClose={() => setBundleDoc(null)}
        />
      )}
      {showBundleModal && (
        <CreateBundleModal
          documentIds={Array.from(selected)}
          onClose={() => setShowBundleModal(false)}
          onDone={(bundleId) => {
            setShowBundleModal(false);
            setSelected(new Set());
            router.push(`/dashboard/bundles/${bundleId}`);
          }}
        />
      )}

      <Modal isOpen={confirmDeleteDrafts} onClose={() => setConfirmDeleteDrafts(false)} title="Permanently delete — cannot be undone">
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {selected.size} draft document{selected.size === 1 ? '' : 's'} will be deleted immediately — the file bytes,
            database record, and any versions are destroyed right now. This skips Trash entirely: there is no 30-day
            recovery window and nothing to restore afterward.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDeleteDrafts(false)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => { bulk.mutate({ operation: 'delete-permanent' }); setConfirmDeleteDrafts(false); }}
              disabled={bulk.isPending}
              className="ui-btn ui-btn-danger"
            >
              {bulk.isPending ? 'Deleting…' : 'Delete Permanently'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={bulkModal === 'move'} onClose={() => setBulkModal(null)} title={`Move ${selected.size} document${selected.size === 1 ? '' : 's'}`}>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Destination folder</span>
            <select value={moveFolderId} onChange={(e) => setMoveFolderId(e.target.value)} className="ui-input mt-1 w-full">
              <option value="">— department root (no folder) —</option>
              {(folderOptions?.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>{f.path ?? f.name}</option>
              ))}
            </select>
          </label>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Placing documents into a folder requires create access on that folder; documents you cannot update are skipped and reported.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setBulkModal(null)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => bulk.mutate({ operation: 'move', params: { folderId: moveFolderId || null } })}
              disabled={bulk.isPending}
              className="ui-btn ui-btn-primary"
            >
              {bulk.isPending ? 'Moving…' : 'Move'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={bulkModal === 'tag'} onClose={() => setBulkModal(null)} title={`Tag ${selected.size} document${selected.size === 1 ? '' : 's'}`}>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Keywords</span>
            <input
              value={tagKeywords}
              onChange={(e) => setTagKeywords(e.target.value)}
              className="ui-input mt-1 w-full"
              maxLength={2000}
              placeholder="Comma-separated, e.g. contract, coffee-export, 2026"
            />
          </label>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Replaces each selected document&apos;s keyword list (searchable metadata).
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setBulkModal(null)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => bulk.mutate({ operation: 'tag', params: { keywords: tagKeywords.trim() } })}
              disabled={bulk.isPending || !tagKeywords.trim()}
              className="ui-btn ui-btn-primary"
            >
              {bulk.isPending ? 'Tagging…' : 'Apply tags'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={bulkModal === 'grant-acl'} onClose={() => setBulkModal(null)} title={`Grant access to ${selected.size} document${selected.size === 1 ? '' : 's'}`}>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Principal type</span>
            <select
              value={grantForm.principalType}
              onChange={(e) => setGrantForm((f) => ({ ...f, principalType: e.target.value as 'user' | 'role', principalId: '' }))}
              className="ui-input mt-1 w-full"
            >
              <option value="user">User</option>
              <option value="role">Role</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>{grantForm.principalType === 'user' ? 'User' : 'Role'}</span>
            <select
              value={grantForm.principalId}
              onChange={(e) => setGrantForm((f) => ({ ...f, principalId: e.target.value }))}
              className="ui-input mt-1 w-full"
            >
              <option value="">— pick —</option>
              {(principalOptions?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {grantForm.principalType === 'user' ? `${p.firstName ?? ''} ${p.lastName ?? ''} (${p.email ?? p.id})` : p.name ?? p.id}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Permission</span>
            <select
              value={grantForm.permission}
              onChange={(e) => setGrantForm((f) => ({ ...f, permission: e.target.value }))}
              className="ui-input mt-1 w-full"
            >
              <option value="document:read">Read</option>
              <option value="document:update">Update</option>
              <option value="document:delete">Delete</option>
              <option value="document:approve">Approve</option>
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => setBulkModal(null)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => bulk.mutate({ operation: 'grant-acl', params: { principalType: grantForm.principalType, principalId: grantForm.principalId, permission: grantForm.permission, effect: 'ALLOW' } })}
              disabled={bulk.isPending || !grantForm.principalId}
              className="ui-btn ui-btn-primary"
            >
              {bulk.isPending ? 'Granting…' : 'Grant'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
