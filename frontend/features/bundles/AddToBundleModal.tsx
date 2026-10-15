'use client';

// Shared "add this document to a bundle" drawer.
// Opened from the document detail page (and any document list row action).
// Lets the user pick an existing DRAFT bundle or create a new one, then
// calls addBundleItem — mirrors the modal patterns in documents/[id]/page.tsx
// (VersionUploadModal / CheckoutModal): fixed overlay + centered card.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Paperclip, Plus, RefreshCw, X } from 'lucide-react';
import { listBundles, createBundle, addBundleItem, type DocumentBundle } from './api';

interface AddToBundleModalProps {
  documentId: string;
  documentTitle?: string;
  onClose: () => void;
}

export function AddToBundleModal({ documentId, documentTitle, onClose }: AddToBundleModalProps) {
  const qc = useQueryClient();
  const [selectedBundleId, setSelectedBundleId] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['bundles', 'picker'], queryFn: () => listBundles(0, 100) });
  const draftBundles = (data?.data ?? []).filter((b: DocumentBundle) => b.status === 'DRAFT');

  const addExisting = useMutation({
    mutationFn: (bundleId: string) => addBundleItem(bundleId, documentId),
    onSuccess: (_res, bundleId) => {
      toast.success('Added to bundle');
      qc.invalidateQueries({ queryKey: ['bundles'] });
      qc.invalidateQueries({ queryKey: ['bundle', bundleId] });
      onClose();
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Could not add document to bundle';
      setError(msg);
      toast.error(msg);
    },
  });

  const createAndAdd = useMutation({
    mutationFn: async (name: string) => {
      const created = await createBundle({ name });
      return addBundleItem(created.data.id, documentId);
    },
    onSuccess: () => {
      toast.success('Bundle created and document added');
      qc.invalidateQueries({ queryKey: ['bundles'] });
      onClose();
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Could not create bundle';
      setError(msg);
      toast.error(msg);
    },
  });

  const pending = addExisting.isPending || createAndAdd.isPending;

  const handleSubmit = () => {
    setError(null);
    if (creatingNew) {
      if (!newName.trim()) {
        setError('Bundle name is required');
        return;
      }
      createAndAdd.mutate(newName.trim());
    } else {
      if (!selectedBundleId) {
        setError('Select a bundle first');
        return;
      }
      addExisting.mutate(selectedBundleId);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      {/* Click-outside scrim. A sibling of the panel rather than its parent,
          so the panel needs no stopPropagation() and carries no click handler
          of its own. role="presentation" is accurate: this layer is a mouse
          convenience, and the dialog's own Cancel/Close button is the
          keyboard path out. */}
      <div className="absolute inset-0" onClick={onClose} role="presentation" />
      <div
        className="relative bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Add to bundle"
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Paperclip className="h-4 w-4 text-brand-600" /> Add to Bundle
          </h2>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary rounded-lg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-5">
          {documentTitle ? <>Stitch <span className="font-semibold text-text-secondary">{documentTitle}</span> into a document bundle.</> : 'Stitch this document into a document bundle.'}
        </p>

        <div className="flex gap-1 p-1 bg-surface-raised rounded-xl w-fit mb-4">
          <button
            onClick={() => setCreatingNew(false)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${!creatingNew ? 'bg-surface-card shadow-sm text-text-primary' : 'text-text-muted'}`}
          >
            Existing bundle
          </button>
          <button
            onClick={() => setCreatingNew(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${creatingNew ? 'bg-surface-card shadow-sm text-text-primary' : 'text-text-muted'}`}
          >
            New bundle
          </button>
        </div>

        {creatingNew ? (
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Bundle name <span className="text-rose-500">*</span>
            </label>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Q3 Procurement Package"
              className="ui-input w-full text-sm"
            />
          </div>
        ) : isLoading ? (
          <p className="text-sm text-text-muted py-4 text-center">Loading bundles…</p>
        ) : draftBundles.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            No draft bundles yet. Switch to &quot;New bundle&quot; to create one.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto ui-scrollbar">
            {draftBundles.map((b) => (
              <label
                key={b.id}
                className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 cursor-pointer hover:bg-surface-raised transition-colors"
                style={selectedBundleId === b.id ? { borderColor: 'var(--brand-500)', background: 'var(--surface-raised)' } : undefined}
              >
                <input
                  type="radio"
                  name="bundle"
                  checked={selectedBundleId === b.id}
                  onChange={() => setSelectedBundleId(b.id)}
                  className="accent-brand-600"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-text-primary truncate">{b.name}</p>
                  <p className="text-xs text-text-muted">{b.items?.length ?? 0} item(s)</p>
                </div>
              </label>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="ui-btn ui-btn-secondary">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={pending} className="ui-btn ui-btn-primary">
            {pending ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Adding…
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" /> Add to Bundle
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
