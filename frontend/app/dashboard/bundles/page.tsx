'use client';

// Phase 5 — Stitch Documents: bundle list.
// Follows the DataTable + PageHeader + TopBar conventions used by
// dashboard/files/page.tsx. Bundles are gated by document:read (same
// permission the bundles routes require server-side).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { Layers, Plus, RefreshCw, X } from 'lucide-react';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { DataTable } from '../../../shared/components/DataTable';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState, InlineError } from '../../../shared/components/ErrorState';
import { getErrorMessage } from '../../../shared/lib/errorMessage';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { useUIStore } from '../../../state/ui.store';
import { listBundles, createBundle, type DocumentBundle } from '../../../features/bundles/api';

const BUNDLES_PAGE_SIZE = 15;

function safeDate(value: unknown, fmt: string): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

function NewBundleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);

  const create = useMutation({
    mutationFn: () => createBundle({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (res) => {
      toast.success('Bundle created');
      qc.invalidateQueries({ queryKey: ['bundles'] });
      onCreated(res.data.id);
    },
    onError: (e: unknown) => {
      setError(e);
      toast.error(getErrorMessage(e, 'Could not create bundle'));
    },
  });

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      {/* Click-outside scrim. A sibling of the panel rather than its parent,
          so the panel needs no stopPropagation() and carries no click handler
          of its own. role="presentation" is accurate: this layer is a mouse
          convenience, and the dialog's own Cancel/Close button is the
          keyboard path out. */}
      <div className="absolute inset-0" onClick={onClose} role="presentation" />
      <div className="relative bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-lg font-bold text-text-primary">New Bundle</h2>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary rounded-lg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-5">
          A bundle stitches several documents together into a single compiled PDF.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Name <span className="text-rose-500">*</span>
            </label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Procurement Package" className="ui-input w-full text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">Description</label>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className="ui-input w-full resize-none text-sm" />
          </div>
          {Boolean(error) && <InlineError error={error} message={getErrorMessage(error, 'Could not create bundle')} />}
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="ui-btn ui-btn-secondary">Cancel</button>
          <button disabled={create.isPending || !name.trim()} onClick={() => create.mutate()} className="ui-btn ui-btn-primary">
            {create.isPending ? (<><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Creating…</>) : (<><Plus className="h-3.5 w-3.5" /> Create bundle</>)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BundlesPage() {
  const router = useRouter();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [showCreate, setShowCreate] = useState(false);
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error: listError, refetch } = useQuery({
    queryKey: ['bundles', page],
    queryFn: () => listBundles((page - 1) * BUNDLES_PAGE_SIZE, BUNDLES_PAGE_SIZE),
  });
  const bundles = data?.data ?? [];
  const total = data?.total ?? bundles.length;
  const totalPages = Math.max(1, Math.ceil(total / BUNDLES_PAGE_SIZE));

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (_v: unknown, row: DocumentBundle) => (
        <div>
          <span className="font-semibold text-text-primary">{row.name}</span>
          {row.description && <p className="text-xs text-text-muted truncate max-w-xs">{row.description}</p>}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v: unknown, row: DocumentBundle) => <StatusBadge status={row.status} />,
    },
    {
      key: 'items',
      label: 'Items',
      render: (_v: unknown, row: DocumentBundle) => (
        <span className="text-sm text-text-secondary">{row.items?.length ?? 0}</span>
      ),
    },
    {
      key: 'compiledDocument',
      label: 'Compiled document',
      render: (_v: unknown, row: DocumentBundle) =>
        row.compiledDocumentId && row.compiledDocument ? (
          <Link
            href={`/dashboard/documents/${row.compiledDocumentId}`}
            onClick={(event) => event.stopPropagation()}
            className="text-sm font-semibold text-brand-600 hover:underline"
          >
            {row.compiledDocument.title || row.compiledDocument.documentName}
          </Link>
        ) : (
          <span className="text-sm text-text-muted">Not compiled</span>
        ),
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      render: (_v: unknown, row: DocumentBundle) => safeDate(row.createdAt, 'MMM d, yyyy'),
    },
  ];

  return (
    <>
      <TopBar
        title="Bundles"
        breadcrumbs={[{ label: 'Repository', href: '/dashboard' }, { label: 'Bundles' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader
          title="Document Bundles"
          subtitle="Stitch multiple documents into a single compiled PDF."
          actions={
            <button onClick={() => setShowCreate(true)} className="ui-btn ui-btn-primary">
              <Plus className="h-4 w-4" /> New bundle
            </button>
          }
        />

        {isError && (
          <div className="ui-card mb-6 p-0">
            <ErrorState error={listError} title="Couldn't load bundles" onRetry={() => refetch()} />
          </div>
        )}

        <DataTable
          columns={columns}
          data={bundles}
          isLoading={isLoading}
          onRowClick={(row) => router.push(`/dashboard/bundles/${row.id}`)}
          mobileTitleKey="name"
          mobileSubtitleKey="createdAt"
          emptyState={
            <EmptyState
              icon={Layers}
              title="No bundles yet"
              description="Create a bundle to stitch several documents together into one compiled PDF."
              action={{ label: 'New bundle', onClick: () => setShowCreate(true) }}
            />
          }
        />
        {total > BUNDLES_PAGE_SIZE && (
          <PaginationControls
            page={page}
            onPageChange={setPage}
            hasPrevious={page > 1}
            hasNext={page < totalPages}
            totalPages={totalPages}
            isLoading={isLoading}
          />
        )}
      </div>

      {showCreate && (
        <NewBundleModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            router.push(`/dashboard/bundles/${id}`);
          }}
        />
      )}
    </>
  );
}
