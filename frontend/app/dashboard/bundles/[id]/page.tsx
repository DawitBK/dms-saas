'use client';

// Phase 5 — Stitch Documents: bundle detail.
// Ordered item list with button-based reorder, remove, "Add document" picker,
// and Compile action. Once COMPILED, reuses DocumentPreviewModal (the same
// preview pattern as documents/[id]/page.tsx) to view the stitched PDF.

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileText,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { PermissionGate } from '../../../../shared/components/PermissionGate';
import { StatusBadge } from '../../../../shared/components/ui/StatusBadge';
import { SkeletonCard } from '../../../../shared/components/ui/SkeletonRow';
import { FileTypeIcon } from '../../../../shared/components/FileTypeIcon';
import { DocumentPreviewModal } from '../../../../shared/components/DocumentPreviewModal';
import { Modal } from '../../../../shared/components/Modal';
import { PERMISSIONS } from '../../../../shared/lib/permissions';
import { useUIStore } from '../../../../state/ui.store';
import { listDocuments } from '../../../../features/documents/api';
import {
  getBundle,
  addBundleItem,
  removeBundleItem,
  reorderBundleItems,
  compileBundle,
  updateBundle,
  deleteBundle,
  type BundleItem,
  type DocumentBundle,
} from '../../../../features/bundles/api';

function AddDocumentPanel({
  bundleId,
  existingIds,
  onClose,
}: {
  bundleId: string;
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['documents', 'bundle-picker', q],
    queryFn: () => listDocuments(0, 20, { q: q || undefined }),
  });

  const add = useMutation({
    mutationFn: (documentId: string) => addBundleItem(bundleId, documentId),
    onSuccess: () => {
      toast.success('Document added to bundle');
      qc.invalidateQueries({ queryKey: ['bundle', bundleId] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not add document'),
  });

  const results = (data?.data ?? []).filter((d) => !existingIds.has(d.id));

  return (
    <div className="ui-card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Plus className="h-4 w-4 text-brand-600" /> Add a document
        </h3>
        <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary rounded-lg">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} className="ui-input pl-8 w-full" placeholder="Search documents to add" />
      </div>
      {isLoading ? (
        <p className="text-sm text-text-muted py-2">Loading…</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-text-muted py-2">No matching documents.</p>
      ) : (
        <div className="space-y-1 max-h-72 overflow-y-auto ui-scrollbar">
          {results.map((d: any) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-surface-raised">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary truncate">{d.title ?? d.documentName}</p>
                <p className="text-xs text-text-muted truncate">{d.documentName}</p>
              </div>
              <button
                onClick={() => add.mutate(d.id)}
                disabled={add.isPending}
                className="ui-btn ui-btn-secondary !py-1 text-xs shrink-0"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BundleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [showAdd, setShowAdd] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  // Compilation is terminal. Hold the committed response separately so an
  // older detail refetch cannot render this bundle as DRAFT again.
  const [compiledOverride, setCompiledOverride] = useState<DocumentBundle | null>(null);

  const { data, isLoading, isError, error } = useQuery({ queryKey: ['bundle', id], queryFn: () => getBundle(id) });
  const bundle = compiledOverride ?? data?.data;
  const items = (bundle?.items ?? []) as BundleItem[];
  const isDraft = bundle?.status === 'DRAFT';

  const removeItem = useMutation({
    mutationFn: (itemId: string) => removeBundleItem(id, itemId),
    onSuccess: () => { toast.success('Item removed'); qc.invalidateQueries({ queryKey: ['bundle', id] }); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not remove item'),
  });

  // Rename / describe: allowed in any state (it is only the label). The creator or an administrator.
  const rename = useMutation({
    mutationFn: () => updateBundle(id, { name: nameDraft.trim(), description: descDraft.trim() || null }),
    onSuccess: (response) => {
      toast.success('Bundle updated');
      setRenaming(false);
      setCompiledOverride(null);
      qc.setQueryData(['bundle', id], response);
      qc.invalidateQueries({ queryKey: ['bundles'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not update the bundle'),
  });

  // Deleting a bundle removes its list only; the documents and a compiled PDF stay exactly as they are.
  const remove = useMutation({
    mutationFn: () => deleteBundle(id),
    onSuccess: (response) => {
      toast.success(response.data.compiledDocumentKept ? 'Bundle deleted — the compiled document was kept' : 'Bundle deleted');
      qc.invalidateQueries({ queryKey: ['bundles'] });
      router.push('/dashboard/bundles');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not delete the bundle'),
  });

  const reorder = useMutation({
    mutationFn: (itemIds: string[]) => reorderBundleItems(id, itemIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bundle', id] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not reorder items'),
  });

  const compile = useMutation({
    mutationFn: () => compileBundle(id),
    onMutate: async () => {
      // A websocket invalidation can start a GET just before the user clicks
      // Compile. That GET still contains DRAFT and would otherwise win the
      // cache race after the successful POST below.
      await qc.cancelQueries({ queryKey: ['bundle', id] });
    },
    onSuccess: async (response) => {
      toast.success('Bundle compiled');
      // The compile response is produced after the transaction has committed
      // and already contains the compiledDocument relation. Put that
      // authoritative state in the detail query immediately, then revalidate
      // in the background. Invalidating alone can race a still-in-flight
      // pre-compile GET and leave this screen showing DRAFT until navigation.
      qc.setQueryData(['bundle', id], response);
      // Compilation creates a new first-class document. Refresh every
      // document surface that can display it, not only the bundle detail,
      // otherwise My Files and dashboard counters remain stale until a full
      // reload (and can misleadingly show only the source items).
      // Complete the cache transition before exposing the completed screen:
      // users commonly open My Files or Dashboard straight from here. Without
      // awaiting this, those inactive lists can mount from their still-fresh
      // pre-compile cache and temporarily omit the new compiled document.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['bundle', id] }),
        qc.invalidateQueries({ queryKey: ['bundles'] }),
        qc.invalidateQueries({ queryKey: ['documents'] }),
        qc.invalidateQueries({ queryKey: ['files-mine'] }),
        qc.invalidateQueries({ queryKey: ['dashboard-stats'] }),
      ]);
      setCompiledOverride(response.data);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Compile failed'),
  });

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((it) => it.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  };

  if (isLoading) {
    return (
      <>
        <TopBar title="Loading…" breadcrumbs={[{ label: 'Repository', href: '/dashboard' }, { label: 'Bundles', href: '/dashboard/bundles' }, { label: '…' }]} onMobileMenuToggle={toggleSidebar} />
        <div className="p-6 max-w-4xl mx-auto space-y-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={4} />
        </div>
      </>
    );
  }

  if (isError || !bundle) {
    return (
      <>
        <TopBar title="Error" onMobileMenuToggle={toggleSidebar} />
        <div className="p-12 text-center">
          <AlertCircle className="h-12 w-12 text-rose-500 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-text-primary mb-2">{isError ? 'Could not load bundle' : 'Bundle not found'}</h3>
          <p className="text-text-muted text-sm mb-6">{isError ? ((error as Error)?.message ?? 'The server rejected this request.') : 'No bundle exists with this ID.'}</p>
          <Link href="/dashboard/bundles" className="ui-btn ui-btn-primary">Back to Bundles</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        title={bundle.name}
        breadcrumbs={[{ label: 'Repository', href: '/dashboard' }, { label: 'Bundles', href: '/dashboard/bundles' }, { label: bundle.name }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="ui-hero flex flex-col md:flex-row justify-between items-start gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <h1 className="text-2xl font-extrabold text-text-primary tracking-tight">{bundle.name}</h1>
                <StatusBadge status={bundle.status} />
              </div>
              {bundle.description && <p className="text-sm text-text-secondary mb-2">{bundle.description}</p>}
              <p className="text-xs text-text-muted">
                {items.length} item{items.length === 1 ? '' : 's'} · created {format(new Date(bundle.createdAt), 'PPp')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <PermissionGate permission={PERMISSIONS.DOCUMENT_READ}>
                <button
                  onClick={() => { setNameDraft(bundle.name); setDescDraft(bundle.description ?? ''); setRenaming(true); }}
                  className="ui-btn ui-btn-secondary"
                  title="Rename this bundle or change its description"
                >
                  <Pencil className="h-4 w-4" /> Rename
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(bundle.status === 'COMPILED'
                      ? 'Delete this bundle? The compiled document stays in the register; only this list is removed.'
                      : 'Delete this bundle? Its documents are not touched; only this list is removed.')) remove.mutate();
                  }}
                  disabled={remove.isPending}
                  className="ui-btn ui-btn-secondary"
                  title="Delete this bundle (creator or administrator)"
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
                {bundle.status === 'DRAFT' && (
                  <button
                    onClick={() => compile.mutate()}
                    disabled={items.length === 0 || compile.isPending}
                    className="ui-btn ui-btn-primary"
                    title={items.length === 0 ? 'Add at least one document before compiling' : undefined}
                  >
                    {compile.isPending ? (<><RefreshCw className="h-4 w-4 animate-spin" /> Compiling…</>) : (<><Layers className="h-4 w-4" /> Compile ({items.length})</>)}
                  </button>
                )}
              </PermissionGate>
            </div>
          </div>

          {bundle.status === 'COMPILED' && bundle.compiledDocument && (
            <div className="ui-card border-emerald-200 bg-emerald-50/40 dark:bg-emerald-900/10">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-text-primary truncate">Compiled document ready</p>
                    <p className="text-xs text-text-muted truncate">{bundle.compiledDocument.documentName}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => setPreviewing(true)} className="ui-btn ui-btn-secondary">
                    <Eye className="h-4 w-4" /> Preview
                  </button>
                  <Link href={`/dashboard/documents/${bundle.compiledDocumentId}`} className="ui-btn ui-btn-primary">
                    <ExternalLink className="h-4 w-4" /> Open document
                  </Link>
                </div>
              </div>
            </div>
          )}

          <div className="ui-card overflow-hidden p-0">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                <FileText className="h-4 w-4 text-brand-600" /> Bundle contents
                <span className="ui-badge">{items.length}</span>
              </h2>
              {isDraft && (
                <button onClick={() => setShowAdd((v) => !v)} className="ui-btn ui-btn-secondary !py-1.5 text-xs">
                  <Plus className="h-3.5 w-3.5" /> Add document
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <div className="py-12 text-center">
                <FileText className="h-10 w-10 text-text-muted mx-auto mb-3" />
                <p className="text-sm text-text-muted">No documents in this bundle yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {items.map((item, index) => {
                  const doc = item.document;
                  const version = doc?.versions?.[0];
                  return (
                    <div key={item.id} className="flex items-center gap-4 px-5 py-3.5">
                      <span
                        aria-label={`Position ${item.position}`}
                        className="h-6 w-6 shrink-0 rounded-full bg-surface-raised flex items-center justify-center text-[11px] font-bold text-text-muted"
                      >
                        {item.position}
                      </span>
                      <FileTypeIcon mimeType={version?.mimeType ?? ''} size={20} />
                      <div className="min-w-0 flex-1">
                        <Link href={`/dashboard/documents/${item.documentId}`} className="text-sm font-semibold text-text-primary hover:text-brand-600 truncate block">
                          {doc?.title ?? doc?.documentName ?? item.documentId}
                        </Link>
                        {doc?.documentName && <p className="text-xs text-text-muted font-mono truncate">{doc.documentName}</p>}
                        {item.adder && <p className="text-xs text-text-muted truncate">Added by {item.adder.firstName} {item.adder.lastName}</p>}
                      </div>
                      {isDraft && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => move(index, -1)} disabled={index === 0 || reorder.isPending} className="ui-btn-icon" aria-label="Move up" title="Move up">
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => move(index, 1)} disabled={index === items.length - 1 || reorder.isPending} className="ui-btn-icon" aria-label="Move down" title="Move down">
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => removeItem.mutate(item.id)} disabled={removeItem.isPending} className="ui-btn-icon" aria-label="Remove" title="Remove from bundle">
                            <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {isDraft && showAdd && (
            <AddDocumentPanel bundleId={id} existingIds={new Set(items.map((i) => i.documentId))} onClose={() => setShowAdd(false)} />
          )}
        </div>
      </div>

      <Modal isOpen={renaming} onClose={() => setRenaming(false)} title="Rename bundle">
        <div className="space-y-3">
          <label className="block text-xs font-semibold uppercase tracking-wider">Name</label>
          <input className="ui-input w-full" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={255} aria-label="Bundle name" />
          <label className="block text-xs font-semibold uppercase tracking-wider">Description (optional)</label>
          <textarea className="ui-input w-full" rows={3} value={descDraft} onChange={(e) => setDescDraft(e.target.value)} maxLength={2000} aria-label="Bundle description" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenaming(false)} className="ui-btn ui-btn-secondary">Back</button>
            <button onClick={() => rename.mutate()} disabled={rename.isPending || !nameDraft.trim()} className="ui-btn ui-btn-primary">
              {rename.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </Modal>

      {previewing && bundle.compiledDocumentId && (
        <DocumentPreviewModal
          documentId={bundle.compiledDocumentId}
          title={bundle.name}
          mimeType="application/pdf"
          documentName={bundle.compiledDocument?.documentName ?? ''}
          onClose={() => setPreviewing(false)}
        />
      )}
    </>
  );
}
