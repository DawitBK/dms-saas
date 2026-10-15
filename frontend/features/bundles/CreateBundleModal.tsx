'use client';

// Shared "create a bundle from N documents" modal. Used by the Files page
// bulk-action toolbar (bundle several already-uploaded documents together)
// and the post-upload "Bundle these documents together" CTA on the upload
// page (bundle a just-uploaded batch together). Mirrors the create-bundle
// name/description prompt on the main Bundles list page (BundlesPage's
// NewBundleModal) but also passes the selected ids to the backend's atomic
// create operation, so the caller never navigates to a silently partial bundle.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Layers, Plus, RefreshCw, X } from 'lucide-react';
import { createBundle } from './api';

interface CreateBundleModalProps {
  documentIds: string[];
  onClose: () => void;
  // Called once the bundle exists with every selected document committed.
  onDone: (bundleId: string) => void;
}

export function CreateBundleModal({ documentIds, onClose, onDone }: CreateBundleModalProps) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const created = await createBundle({
        name: name.trim(),
        description: description.trim() || undefined,
        documentIds,
      });
      return { bundleId: created.data.id, total: documentIds.length };
    },
    onSuccess: ({ bundleId, total }) => {
      toast.success(`Bundle created with ${total} document${total === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: ['bundles'] });
      onDone(bundleId);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Could not create bundle';
      setError(msg);
      toast.error(msg);
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
      <div
        className="relative bg-surface-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6"
        role="dialog"
        aria-modal="true"
        aria-label="New bundle"
      >
        <div className="flex items-start justify-between mb-1">
          <h2 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Layers className="h-4 w-4 text-brand-600" /> New Bundle
          </h2>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text-primary rounded-lg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-5">
          Stitch {documentIds.length} document{documentIds.length === 1 ? '' : 's'} together into a single compiled PDF.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Name <span className="text-rose-500">*</span>
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 Procurement Package"
              className="ui-input w-full text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
              Description
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="ui-input w-full resize-none text-sm"
            />
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="ui-btn ui-btn-secondary">
            Cancel
          </button>
          <button disabled={create.isPending || !name.trim()} onClick={() => create.mutate()} className="ui-btn ui-btn-primary">
            {create.isPending ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Creating…
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" /> Create bundle
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
