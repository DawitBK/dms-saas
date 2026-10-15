'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { FileSignature, CheckCircle2, ExternalLink } from 'lucide-react';
import { listMySignatureTasks, fetchSigningDocumentBlobUrl, type MySignatureTask } from '../../../../features/signing/internalApi';
import { apiClient } from '../../../../shared/lib/apiClient';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { EmptyState } from '../../../../shared/components/EmptyState';
import { Modal } from '../../../../shared/components/Modal';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { PdfBlobPreview } from '../../../../shared/components/PdfBlobPreview';
import { SignaturePad } from '../../../../features/signing/components/SignaturePad';
import { signingErrorMessage } from '../../../../features/signing/errors';
import { useAuthStore } from '../../../../state/auth.store';
import { useUIStore } from '../../../../state/ui.store';
import { useResetOnChange } from '../../../../shared/hooks/useResetOnChange';

const PAGE_SIZE = 25;

function safeDate(value: unknown): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, 'MMM d, yyyy');
}

export default function PendingSignaturesPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const qc = useQueryClient();
  const { firstName, lastName, email, userId } = useAuthStore();
  const [page, setPage] = useState(1);
  const [signTarget, setSignTarget] = useState<MySignatureTask | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  // FIX 2026-09-15: this modal used to ask for a signature with zero way to
  // see the document being signed — see fetchSigningDocumentBlobUrl's own
  // comment. Loaded per-target (not once) since each row is a different
  // request/document.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Same query key as ProfileSettingsPanel.tsx's own /users/me fetch, so a
  // signer who's already visited Settings this session gets this for free
  // from cache instead of a second round trip — pre-fills SignaturePad with
  // whatever signature they saved there (see that prop's own comment).
  const { data: myProfile } = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => apiClient<{ signatureImage?: string | null }>('/users/me'),
  });

  // Clearing the previous target's preview is a pure function of which
  // target is open, so it's adjusted during render rather than in the effect
  // below (react-hooks/set-state-in-effect) — same pattern as
  // DocumentPreviewModal.tsx.
  useResetOnChange([signTarget?.id ?? null], () => {
    setPreviewUrl(null);
    setPreviewError(null);
  });

  useEffect(() => {
    if (!signTarget) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchSigningDocumentBlobUrl(signTarget.request!.id, signTarget.id)
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setPreviewUrl(url);
      })
      .catch((e: unknown) => { if (!cancelled) setPreviewError(signingErrorMessage(e, 'Could not load a preview')); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signTarget?.id]);

  const { data, isLoading } = useQuery({
    queryKey: ['signing', 'pending-me', page],
    queryFn: () => listMySignatureTasks((page - 1) * PAGE_SIZE, PAGE_SIZE),
  });
  const tasks = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Signs straight from this list's own data (this row IS the recipient, and
  // now carries the request's fields — see listMySignatureTasks) instead of
  // routing through GET /documents/:id/signing, which requires document:read
  // ACL. That 403'd for a recipient named on a request for a document outside
  // their normal folder/department scope — even though the sign endpoint
  // itself has no such gate, it only checks that the caller IS the named
  // recipient. The old "Sign now" link bounced to a page that silently
  // rendered that 403 as "no signature requests for this document."
  const signRecipient = useMutation({
    mutationFn: ({ task, signature }: { task: MySignatureTask; signature: string }) =>
      apiClient(`/signing/${task.request!.id}/recipients/${task.id}/sign`, {
        method: 'POST',
        body: JSON.stringify({
          fieldValues: (task.request?.fields ?? []).filter((f) => f.recipientId === task.id).map((f) => ({
            fieldId: f.id,
            value: f.fieldType === 'date'
              ? new Date().toLocaleDateString()
              : ['signature', 'initial', 'seal'].includes(f.fieldType)
                ? signature
                : (`${firstName ?? ''} ${lastName ?? ''}`.trim() || email || userId || 'Signed'),
          })),
        }),
      }),
    onSuccess: () => {
      toast.success('Signed');
      setSignTarget(null);
      setSignatureDataUrl(null);
      qc.invalidateQueries({ queryKey: ['signing'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      qc.invalidateQueries({ queryKey: ['my-work-count'] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['dashboard-stats'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Sign failed')),
  });

  return (
    <>
      <TopBar
        title="E-Signing"
        breadcrumbs={[{ label: 'E-Signing', href: '/dashboard/signing/pending' }, { label: 'Pending My Signature' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader title="Pending My Signature" subtitle="Documents waiting on you across every request — no need to know which document to look up first." />

        {isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
        ) : tasks.length === 0 ? (
          <EmptyState icon={FileSignature} title="Nothing waiting on you" description="Signature requests assigned to you will show up here." />
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.id} className="ui-card flex items-center gap-3">
                <FileSignature size={18} style={{ color: 'var(--brand-600)' }} className="shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {t.request?.document?.documentName ?? t.request?.document?.title ?? 'Document'}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Requested {safeDate(t.request?.createdAt)}</p>
                </div>
                <button
                  onClick={() => { setSignTarget(t); setSignatureDataUrl(null); }}
                  className="ui-btn ui-btn-primary !py-1.5 text-xs shrink-0"
                >
                  <CheckCircle2 size={14} /> Sign now
                </button>
              </div>
            ))}
          </div>
        )}

        {total > PAGE_SIZE && (
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

      <Modal isOpen={Boolean(signTarget)} onClose={() => setSignTarget(null)} title="Sign this document" size="2xl">
        <div className="space-y-3">
          <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            <div className="px-3 py-2 flex items-center justify-between" style={{ background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' }}>
              <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Document you are about to sign
              </p>
              {previewUrl && (
                <a href={previewUrl} target="_blank" rel="noreferrer" className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--brand-600)' }}>
                  <ExternalLink className="h-3 w-3" /> Open in new tab
                </a>
              )}
            </div>
            {previewError ? (
              <div className="p-4 text-[12px]" style={{ color: 'var(--color-red-600, #dc2626)' }}>
                Couldn&apos;t load a preview: {previewError}. You can still sign, but review the document another way first.
              </div>
            ) : previewUrl ? (
              <div className="max-h-[420px] overflow-y-auto p-2">
                <PdfBlobPreview blobUrl={previewUrl} maxWidth={560} />
              </div>
            ) : (
              <div className="h-[160px] flex items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Loading document…
              </div>
            )}
          </div>
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Draw your signature, or type your name to render it in a signature-style font. This applies to every
            signature/initial/seal field assigned to you on this request.
          </p>
          <SignaturePad
            defaultTypedName={`${firstName ?? ''} ${lastName ?? ''}`.trim()}
            defaultSignatureImage={myProfile?.signatureImage}
            onChange={setSignatureDataUrl}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setSignTarget(null)} className="ui-btn ui-btn-secondary">Cancel</button>
            <button
              onClick={() => signTarget && signatureDataUrl && signRecipient.mutate({ task: signTarget, signature: signatureDataUrl })}
              disabled={signRecipient.isPending || !signatureDataUrl}
              className="ui-btn ui-btn-primary"
            >
              {signRecipient.isPending ? 'Working…' : 'Confirm & Sign'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
