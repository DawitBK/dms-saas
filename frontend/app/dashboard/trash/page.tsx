'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Trash2, RotateCcw, ShieldAlert, Clock, RefreshCw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { apiClient } from '../../../shared/lib/apiClient';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { DataTable } from '../../../shared/components/DataTable';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { useUIStore } from '../../../state/ui.store';
import { useAuthStore } from '../../../state/auth.store';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../../shared/lib/permissions';

function safeDate(value: unknown, fmt: string): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

type TrashedDoc = {
  id: string;
  title: string;
  documentName: string;
  preTrashStatus: string | null;
  deletedAt: string | null;
  daysUntilPurge: number | null;
  department?: { code: string; name: string } | null;
  documentType?: { code: string; name: string } | null;
  owner?: { firstName: string; lastName: string; email: string } | null;
  purgePending?: { status: string; stagedById: string | null } | null;
};

export default function TrashPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { userId } = useAuthStore();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [confirmPurge, setConfirmPurge] = useState<TrashedDoc | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const TRASH_PAGE_SIZE = 15;
  // The purge/approve response hands back the certificate reference exactly
  // once (previously just a toast, no way to see it again) — fetch the full
  // record (now resolving authorisedBy to a name, see trashService.ts's
  // getCertificateOfDestruction) and show it in a real viewer instead.
  const [viewCertificate, setViewCertificate] = useState<{
    reference: string;
    documentIds: string;
    disposalMethod: string;
    authorisedAt: string;
    issuedAt: string;
    authorisedBy?: { firstName: string; lastName: string; email: string } | null;
  } | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['documents', 'trash', page],
    queryFn: () =>
      apiClient<{ data: TrashedDoc[]; total: number }>(
        `/documents/trash?skip=${(page - 1) * TRASH_PAGE_SIZE}&take=${TRASH_PAGE_SIZE}`,
      ),
  });
  const trashTotal = data?.total ?? 0;
  const trashTotalPages = Math.max(1, Math.ceil(trashTotal / TRASH_PAGE_SIZE));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const restore = useMutation({
    mutationFn: (id: string) => apiClient(`/documents/${id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Document restored to its previous status');
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Restore failed'),
  });

  const stagePurge = useMutation({
    mutationFn: (id: string) => apiClient(`/documents/${id}/purge/stage`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      toast.success('Purge staged — a second authorized user must approve the destruction');
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Staging purge failed'),
  });

  const bulkRestore = useMutation({
    mutationFn: () =>
      apiClient<{ summary: { succeeded: number; failed: number } }>('/documents/bulk', {
        method: 'POST',
        body: JSON.stringify({ operation: 'restore', documentIds: Array.from(selected) }),
      }),
    onSuccess: (res) => {
      const { succeeded, failed } = res.summary;
      if (failed === 0) toast.success(`Restored ${succeeded} document${succeeded === 1 ? '' : 's'}`);
      else toast(`${succeeded} restored, ${failed} failed`, { icon: '⚠️' });
      setSelected(new Set());
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Bulk restore failed'),
  });

  const cancelPurge = useMutation({
    mutationFn: (id: string) => apiClient(`/documents/${id}/purge/cancel`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      toast.success('Destruction cancelled — the document stays in trash');
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Cancel failed'),
  });

  const approvePurge = useMutation({
    mutationFn: (id: string) => apiClient<{ certificateReference: string }>(`/documents/${id}/purge/approve`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: async (res) => {
      toast.success(`Document permanently destroyed — certificate ${res.certificateReference}`);
      setConfirmPurge(null);
      invalidate();
      try {
        const cert = await apiClient<{ data: typeof viewCertificate }>(`/documents/certificates/${res.certificateReference}`);
        setViewCertificate(cert.data);
      } catch {
        // Non-fatal — the toast above already confirmed the reference; the
        // viewer is a convenience, not the source of truth for the destruction.
      }
    },
    onError: (e: unknown) => {
      setConfirmPurge(null);
      toast.error(e instanceof Error ? e.message : 'Purge approval failed');
    },
  });

  const docs = data?.data ?? [];
  const canPurge = can(PERMISSIONS.DOCUMENT_PURGE);

  const columns = [
    {
      key: 'select',
      label: '',
      mobileHidden: true,
      render: (_v: unknown, row: TrashedDoc) => (
        <input
          type="checkbox"
          checked={selected.has(row.id)}
          onChange={() =>
            setSelected((prev) => {
              const next = new Set(prev);
              next.has(row.id) ? next.delete(row.id) : next.add(row.id);
              return next;
            })
          }
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${row.title}`}
          className="h-4 w-4 rounded border-border accent-brand-600 cursor-pointer"
        />
      ),
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      render: (_v: unknown, row: TrashedDoc) => (
        <>
          <span className="font-semibold text-text-primary">{row.title}</span>
          <span className="text-[10px] font-mono text-text-muted ml-1">{row.documentName}</span>
        </>
      ),
    },
    {
      key: 'preTrashStatus',
      label: 'Was',
      mobileHidden: true,
      render: (_v: unknown, row: TrashedDoc) => <StatusBadge status={row.preTrashStatus ?? 'DRAFT'} />,
    },
    {
      key: 'deletedAt',
      label: 'Trashed',
      sortable: true,
      render: (_v: unknown, row: TrashedDoc) => safeDate(row.deletedAt, 'MMM d, yyyy'),
    },
    {
      key: 'daysUntilPurge',
      label: 'Auto-destroys in',
      render: (_v: unknown, row: TrashedDoc) =>
        row.daysUntilPurge === null ? (
          <span className="text-text-muted text-xs">--</span>
        ) : (
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold ${
              row.daysUntilPurge <= 7 ? 'text-red-600' : 'text-text-primary'
            }`}
          >
            <Clock className="h-3.5 w-3.5" />
            {row.daysUntilPurge} day{row.daysUntilPurge === 1 ? '' : 's'}
          </span>
        ),
    },
    {
      key: 'actions',
      label: '',
      render: (_v: unknown, row: TrashedDoc) => (
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={() => restore.mutate(row.id)}
            disabled={restore.isPending}
            className="ui-btn ui-btn-secondary text-xs"
            title="Restore to its pre-trash status"
          >
            {restore.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Restore
          </button>
          {canPurge && row.purgePending?.status === 'PENDING' && (
            <button
              onClick={() => cancelPurge.mutate(row.id)}
              disabled={cancelPurge.isPending}
              className="ui-btn ui-btn-secondary text-xs"
              title="Cancel the scheduled destruction — the document stays in trash and can still be restored"
            >
              Cancel destruction
            </button>
          )}
          {canPurge && (
            row.purgePending?.stagedById && row.purgePending.stagedById !== userId ? (
              <button
                onClick={() => setConfirmPurge(row)}
                disabled={approvePurge.isPending}
                className="ui-btn ui-btn-danger text-xs"
                title="Approve permanent destruction (staged by another user)"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Approve destruction
              </button>
            ) : (
              <button
                onClick={() => stagePurge.mutate(row.id)}
                disabled={stagePurge.isPending || row.purgePending?.stagedById === userId}
                className="ui-btn ui-btn-danger text-xs"
                title={
                  row.purgePending?.stagedById === userId
                    ? 'You staged this purge — a different authorized user must approve it'
                    : 'Stage permanent destruction (a second user must approve)'
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
                {row.purgePending?.stagedById === userId ? 'Awaiting approval' : 'Destroy…'}
              </button>
            )
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <TopBar
        title="Recycle Bin"
        breadcrumbs={[{ label: 'Repository', href: '/dashboard' }, { label: 'Recycle Bin' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader
          title="Recycle Bin"
          subtitle="Trashed documents are recoverable for 30 days, then permanently destroyed after a 7-day cooling period"
        />

        {isError && (
          <div className="ui-card mb-6 p-0">
            <ErrorState error={error} title="Couldn't load the recycle bin" onRetry={() => refetch()} />
          </div>
        )}

        {selected.size > 0 && (
          <div className="flex items-center gap-3 mb-4 px-4 py-2.5 rounded-xl bg-brand-50 border border-brand-200 dark:bg-brand-500/15 dark:border-brand-500/30">
            <span className="text-sm font-semibold text-text-primary">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => bulkRestore.mutate()} disabled={bulkRestore.isPending} className="ui-btn ui-btn-primary text-xs">
                {bulkRestore.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Restore selected
              </button>
              <button onClick={() => setSelected(new Set())} className="ui-btn ui-btn-ghost text-xs">Clear</button>
            </div>
          </div>
        )}

        <DataTable
          columns={columns}
          data={docs}
          isLoading={isLoading}
          mobileTitleKey="title"
          mobileSubtitleKey="deletedAt"
          emptyState={
            <EmptyState
              icon={Trash2}
              title="Trash is empty"
              description="Documents you move to trash appear here for 30 days before permanent destruction."
            />
          }
        />
        {trashTotal > TRASH_PAGE_SIZE && (
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={page * TRASH_PAGE_SIZE < trashTotal}
            totalPages={trashTotalPages}
            isLoading={isLoading}
          />
        )}
      </div>

      {confirmPurge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setConfirmPurge(null)} role="presentation" />
          <div className="relative ui-card max-w-md w-full">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2 mb-2">
              <ShieldAlert className="h-4 w-4 text-red-600" /> Permanent destruction — cannot be undone
            </h3>
            <p className="text-sm text-text-muted mb-1">
              <span className="font-semibold text-text-primary">{confirmPurge.title}</span> ({confirmPurge.documentName})
            </p>
            <p className="text-xs text-text-muted mb-4">
              The encryption keys, database records, and file bytes will be destroyed and a Certificate of
              Destruction issued. Documents under legal hold cannot be destroyed.
            </p>
            <div className="flex justify-end gap-2">
              <button className="ui-btn ui-btn-secondary text-xs" onClick={() => setConfirmPurge(null)}>
                Cancel
              </button>
              <button
                className="ui-btn ui-btn-danger text-xs"
                disabled={approvePurge.isPending}
                onClick={() => approvePurge.mutate(confirmPurge.id)}
              >
                {approvePurge.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Destroy permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {viewCertificate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* Click-outside scrim. A sibling of the panel rather than its parent,
              so the panel needs no stopPropagation() and carries no click handler
              of its own. role="presentation" is accurate: this layer is a mouse
              convenience, and the dialog's own Cancel/Close button is the
              keyboard path out. */}
          <div className="absolute inset-0" onClick={() => setViewCertificate(null)} role="presentation" />
          <div className="relative ui-card max-w-md w-full">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2 mb-3">
              <ShieldAlert className="h-4 w-4 text-red-600" /> Certificate of Destruction
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-text-muted">Reference</dt>
                <dd className="font-mono text-text-primary">{viewCertificate.reference}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-muted">Disposal method</dt>
                <dd className="text-text-primary">{viewCertificate.disposalMethod}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-muted">Authorised by</dt>
                <dd className="text-text-primary">
                  {viewCertificate.authorisedBy
                    ? `${viewCertificate.authorisedBy.firstName} ${viewCertificate.authorisedBy.lastName}`
                    : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-muted">Authorised at</dt>
                <dd className="text-text-primary">{safeDate(viewCertificate.authorisedAt, 'PPp')}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-muted">Issued</dt>
                <dd className="text-text-primary">{safeDate(viewCertificate.issuedAt, 'PPp')}</dd>
              </div>
            </dl>
            <div className="flex justify-end mt-4">
              <button className="ui-btn ui-btn-secondary text-xs" onClick={() => setViewCertificate(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
