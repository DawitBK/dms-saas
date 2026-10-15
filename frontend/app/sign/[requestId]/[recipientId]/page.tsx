'use client';

// External e-signing landing page — the link emailed to a signer who has NO
// DMS account (see esigning.service.ts sendSignatureRequest()). Lives
// OUTSIDE the dashboard/(AuthGuard) tree, same pattern as the public CAMS
// QR-verify page (frontend/app/verify/page.tsx): no login, no Authorization
// header, auth is a per-recipient access token carried as `?token=`.

import { use, useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Loader2, FileSignature, Clock, ShieldAlert, Ban, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  declineExternal,
  getExternalSigningView,
  fetchExternalSigningDocumentBlobUrl,
  signExternal,
  SigningApiError,
  type ExternalSigningView,
} from '../../../../features/signing/api';
import { SignaturePad } from '../../../../features/signing/components/SignaturePad';
import { signingErrorMessage } from '../../../../features/signing/errors';
import { useResetOnChange } from '../../../../shared/hooks/useResetOnChange';

const FIELD_LABELS: Record<string, string> = {
  signature: 'Signature',
  initial: 'Initials',
  date: 'Date',
  text: 'Text',
  seal: 'Seal',
};

function SignContent({ requestId, recipientId }: { requestId: string; recipientId: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [fullName, setFullName] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [actionResult, setActionResult] = useState<'signed' | 'declined' | null>(null);
  // FIX 2026-09-15: an external signer — no DMS account, arriving from an
  // emailed link — used to see only a list of field placeholders
  // ("Signature · p.1") and a name box, never the document itself. See
  // fetchExternalSigningDocumentBlobUrl's own comment.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const viewQuery = useQuery({
    queryKey: ['external-signing-view', requestId, recipientId, token],
    queryFn: () => getExternalSigningView(requestId, recipientId, token),
    enabled: Boolean(requestId && recipientId && token),
    retry: false,
  });

  useEffect(() => {
    if (!requestId || !recipientId || !token) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchExternalSigningDocumentBlobUrl(requestId, recipientId, token)
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
  }, [requestId, recipientId, token]);

  // Seed the name box the first time the request loads — never overwrite what
  // the signer has typed, which is what the `!fullName` guard is for. Adjusted
  // during render rather than in an effect: the effect version rendered the
  // form once with an empty name box before filling it in, and
  // react-hooks/set-state-in-effect rejects it under eslint-config-next 16.
  useResetOnChange([viewQuery.data], () => {
    if (viewQuery.data && !fullName) setFullName(viewQuery.data.recipient.name);
  });

  const signMutation = useMutation({
    mutationFn: (data: ExternalSigningView) =>
      signExternal(
        requestId,
        recipientId,
        token,
        data.fields.map((f) => ({
          fieldId: f.id,
          value: f.fieldType === 'date'
            ? new Date().toLocaleDateString()
            : ['signature', 'initial', 'seal'].includes(f.fieldType)
              ? (signatureDataUrl ?? fullName.trim() ?? data.recipient.name)
              : (fullName.trim() || data.recipient.name),
        })),
      ),
    onSuccess: () => {
      toast.success('Document signed');
      setActionResult('signed');
    },
    onError: (e: unknown) => {
      if (e instanceof SigningApiError && e.code === 'ERR-SIGNING-EXPIRED') {
        setActionResult(null);
        toast.error('This signing request has expired');
        viewQuery.refetch();
        return;
      }
      toast.error(signingErrorMessage(e, 'Failed to sign'));
    },
  });

  const declineMutation = useMutation({
    mutationFn: () => declineExternal(requestId, recipientId, token, declineReason.trim()),
    onSuccess: () => {
      toast.success('Signature request declined');
      setActionResult('declined');
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Failed to decline')),
  });

  if (!requestId || !recipientId || !token) {
    return (
      <ResultCard tone="error" icon={<ShieldAlert className="h-10 w-10" />} title="Invalid signing link">
        <p>This link is missing required information. Ask the sender to resend the signing invitation.</p>
      </ResultCard>
    );
  }

  if (viewQuery.isLoading) {
    return (
      <ResultCard tone="neutral" icon={<Loader2 className="h-10 w-10 animate-spin" />} title="Loading document…">
        <p>Please wait while we verify your signing link.</p>
      </ResultCard>
    );
  }

  if (viewQuery.isError) {
    const err = viewQuery.error;
    const code = err instanceof SigningApiError ? err.code : undefined;
    const status = err instanceof SigningApiError ? err.status : undefined;

    if (status === 410 || code === 'ERR-SIGNING-EXPIRED') {
      return (
        <ResultCard tone="error" icon={<Clock className="h-10 w-10" />} title="This signing request has expired">
          <p>The sender set a deadline for this document and it has passed. Contact the sender to request a new signing link.</p>
        </ResultCard>
      );
    }
    if (status === 403) {
      return (
        <ResultCard tone="error" icon={<ShieldAlert className="h-10 w-10" />} title="Link no longer valid">
          <p>This signing link is invalid, has expired, or was replaced by a newer one (every reminder email carries a fresh link and cancels the earlier one). Use the most recent email from the sender, or ask them for a new link.</p>
        </ResultCard>
      );
    }
    if (status === 404) {
      return (
        <ResultCard tone="error" icon={<XCircle className="h-10 w-10" />} title="Signing request not found">
          <p>We couldn&apos;t find this document. It may have been removed.</p>
        </ResultCard>
      );
    }
    return (
      <ResultCard tone="error" icon={<XCircle className="h-10 w-10" />} title="Something went wrong">
        <p>{signingErrorMessage(err, 'The signing service could not be reached. Try again later.')}</p>
      </ResultCard>
    );
  }

  const data = viewQuery.data;
  if (!data) return null;

  if (data.request.status === 'expired') {
    return (
      <ResultCard tone="error" icon={<Clock className="h-10 w-10" />} title="This signing request has expired">
        <p>Contact the sender to request a new signing link.</p>
      </ResultCard>
    );
  }

  if (data.request.status === 'voided') {
    return (
      <ResultCard tone="error" icon={<Ban className="h-10 w-10" />} title="Signing request cancelled">
        <p>This signature request is no longer active.</p>
      </ResultCard>
    );
  }

  if (actionResult === 'declined' || data.recipient.status === 'declined') {
    return (
      <ResultCard tone="neutral" icon={<Ban className="h-10 w-10" />} title="You declined to sign">
        <p className="font-medium text-slate-100">{data.request.documentName ?? 'Document'}</p>
        <p className="mt-2">The sender has been notified of your decision.</p>
      </ResultCard>
    );
  }

  if (actionResult === 'signed' || data.recipient.status === 'signed') {
    return (
      <ResultCard tone="success" icon={<CheckCircle2 className="h-10 w-10" />} title="You&apos;re done signing">
        <p className="font-medium text-slate-100">{data.request.documentName ?? 'Document'}</p>
        <p className="mt-2">
          {data.request.status === 'completed'
            ? 'All parties have signed. A copy has been recorded.'
            : 'Your signature has been recorded. Waiting on the remaining signers.'}
        </p>
      </ResultCard>
    );
  }

  const needsSignatureCapture = data.fields.some((f) => ['signature', 'initial', 'seal'].includes(f.fieldType));

  // Serial ordering: soft-block signing (and surface why) if an earlier
  // recipient hasn't signed yet — the backend also enforces this on submit
  // (ERR-SIGNING-OUT-OF-ORDER), this just avoids a confusing round trip.
  const blockedBySerialOrder =
    data.request.orderingMode === 'serial' &&
    data.recipients.some((r) => r.orderIndex < data.recipient.orderIndex && r.status !== 'signed');

  return (
    <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900/80 p-8 shadow-2xl">
      <div className="mb-5 flex items-start gap-3">
        <div className="rounded-xl bg-brand-500/10 p-2.5 text-brand-400">
          <FileSignature className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-slate-50">{data.request.documentName ?? 'Document to sign'}</h1>
          <p className="text-[13px] text-slate-400">
            You were invited to sign as <span className="font-medium text-slate-200">{data.recipient.name}</span> ({data.recipient.email})
          </p>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-slate-700 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-slate-800/60">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Document you are about to sign</p>
          {previewUrl && (
            <a href={previewUrl} target="_blank" rel="noreferrer" className="text-[11px] inline-flex items-center gap-1 text-brand-400 hover:text-brand-300">
              <ExternalLink className="h-3 w-3" /> Open in new tab
            </a>
          )}
        </div>
        {previewError ? (
          <div className="p-4 text-[12px] text-amber-300 bg-slate-900/60">
            Couldn&apos;t load a preview: {previewError}. You can still sign, but review the document another way first.
          </div>
        ) : previewUrl ? (
          <iframe src={previewUrl} className="w-full h-[380px] bg-white" title="Document to sign" />
        ) : (
          <div className="h-[140px] flex items-center justify-center text-[12px] text-slate-400 bg-slate-900/60">
            Loading document…
          </div>
        )}
      </div>

      {blockedBySerialOrder && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-[13px] text-amber-300">
          <Clock className="h-4 w-4 shrink-0" />
          Waiting for earlier signers to complete their signatures before you can sign.
        </div>
      )}

      {data.fields.length > 0 && (
        <div className="mb-4 space-y-1.5">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">Fields to complete</p>
          <div className="flex flex-wrap gap-1.5">
            {data.fields.map((f) => (
              <span key={f.id} className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-1 text-[12px] text-slate-300">
                {FIELD_LABELS[f.fieldType] ?? f.fieldType} · p.{f.pageNumber}
              </span>
            ))}
          </div>
        </div>
      )}

      <label className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-slate-400" htmlFor="signer-name">
        Your full name
      </label>
      <input
        id="signer-name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        placeholder="Full legal name"
        className="mb-4 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-brand-500"
      />

      {needsSignatureCapture && (
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-400">Your signature</p>
          <SignaturePad defaultTypedName={fullName} onChange={setSignatureDataUrl} />
        </div>
      )}

      {showDecline ? (
        <div className="space-y-3">
          <label className="block text-[12px] font-semibold uppercase tracking-wide text-slate-400" htmlFor="decline-reason">
            Reason for declining (optional)
          </label>
          <textarea
            id="decline-reason"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-brand-500"
          />
          <div className="flex gap-2">
            <button
              onClick={() => declineMutation.mutate()}
              disabled={declineMutation.isPending}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
            >
              {declineMutation.isPending ? 'Declining…' : 'Confirm decline'}
            </button>
            <button
              onClick={() => setShowDecline(false)}
              disabled={declineMutation.isPending}
              className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => signMutation.mutate(data)}
            disabled={signMutation.isPending || !fullName.trim() || (needsSignatureCapture && !signatureDataUrl) || blockedBySerialOrder}
            className="flex-1 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 disabled:opacity-50"
          >
            {signMutation.isPending ? 'Signing…' : 'Sign document'}
          </button>
          <button
            onClick={() => setShowDecline(true)}
            disabled={signMutation.isPending}
            className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            Decline
          </button>
        </div>
      )}

      <p className="mt-5 text-center text-[11px] text-slate-500">
        By signing you agree this constitutes your electronic signature on this document.
      </p>
    </div>
  );
}

function ResultCard({
  tone, icon, title, children,
}: { tone: 'success' | 'error' | 'neutral'; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const toneColor = tone === 'success' ? 'text-emerald-400' : tone === 'error' ? 'text-red-400' : 'text-slate-300';
  return (
    <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900/80 p-8 text-center shadow-2xl">
      <div className={`mx-auto mb-4 flex justify-center ${toneColor}`}>{icon}</div>
      <h1 className="text-xl font-bold text-slate-50">{title}</h1>
      <div className="mt-3 text-[14px] text-slate-300">{children}</div>
    </div>
  );
}

export default function ExternalSignPage({
  params,
}: {
  params: Promise<{ requestId: string; recipientId: string }>;
}) {
  const { requestId, recipientId } = use(params);

  return (
    <div className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center overflow-y-auto bg-slate-950 px-4 py-10">
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <p className="text-2xl font-black tracking-tight text-white">EXAMPLE CORP</p>
          <p className="text-[13px] text-slate-400">Electronic Signature Request</p>
        </div>
        <Suspense
          fallback={
            <ResultCard tone="neutral" icon={<Loader2 className="h-10 w-10 animate-spin" />} title="Loading…">
              <p />
            </ResultCard>
          }
        >
          <SignContent requestId={requestId} recipientId={recipientId} />
        </Suspense>
      </div>
    </div>
  );
}
