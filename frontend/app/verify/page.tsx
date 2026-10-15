'use client';

// CAMS public QR verification page (6.1.5). Anyone who scans the QR code on a
// printed letter lands here — no login required. Shows only non-sensitive
// confirmation data: reference number, issuing unit, signatory, date, and the
// authentic / not-authentic integrity verdict.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldX, Loader2 } from 'lucide-react';
import { verifyLetterPublic } from '../../features/letters/api';

function VerifyContent() {
  const params = useSearchParams();
  const ref = params.get('ref') ?? '';
  const hash = params.get('hash') ?? '';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['verify-letter', ref, hash],
    queryFn: () => verifyLetterPublic(ref, hash),
    enabled: Boolean(ref && hash),
    retry: 1,
  });

  if (!ref || !hash) {
    return (
      <ResultCard tone="error" icon={<ShieldX className="h-10 w-10" />} title="Invalid verification link">
        <p>This link is missing the reference number or verification code. Re-scan the QR code on the letter.</p>
      </ResultCard>
    );
  }

  if (isLoading) {
    return (
      <ResultCard tone="neutral" icon={<Loader2 className="h-10 w-10 animate-spin" />} title="Verifying…">
        <p className="font-mono text-[13px] break-all">{ref}</p>
      </ResultCard>
    );
  }

  if (isError || !data) {
    return (
      <ResultCard tone="error" icon={<ShieldX className="h-10 w-10" />} title="Verification unavailable">
        <p>The verification service could not be reached. Try again later.</p>
      </ResultCard>
    );
  }

  if (!data.authentic) {
    return (
      <ResultCard tone="error" icon={<ShieldX className="h-10 w-10" />} title="Document could not be verified">
        <p className="font-mono text-[13px] break-all">{ref}</p>
        <p className="mt-2">
          This letter is <strong>not registered</strong> in the Example Corp correspondence system, or its content
          has been <strong>altered</strong> after signing. Treat it as unverified.
        </p>
      </ResultCard>
    );
  }

  return (
    <ResultCard tone="success" icon={<ShieldCheck className="h-10 w-10" />} title="Document is authentic">
      <dl className="mt-2 space-y-2 text-left">
        <Row label="Reference No." value={data.referenceNumber ?? '--'} mono />
        <Row label="Issuing unit" value={data.issuingUnit ? `${data.issuingUnit.name} (${data.issuingUnit.code})` : '--'} />
        <Row label="Signed by" value={data.signatoryName ? `${data.signatoryName} — ${data.signatoryTitle ?? ''}` : '--'} />
        <Row label="Date" value={data.approvedAt ? new Date(data.approvedAt).toLocaleDateString() : '--'} />
      </dl>
      <p className="mt-4 text-[12px] text-slate-400">
        Integrity check passed against the stored cryptographic hash. Full content requires an authorized login.
      </p>
    </ResultCard>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-3">
      <dt className="w-28 shrink-0 text-[12px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`text-[14px] text-slate-100 ${mono ? 'font-mono text-[13px]' : ''}`}>{value}</dd>
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

export default function VerifyPage() {
  return (
    <div className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <p className="text-2xl font-black tracking-tight text-white">EXAMPLE CORP</p>
          <p className="text-[13px] text-slate-400">Correspondence Verification</p>
        </div>
        <Suspense
          fallback={
            <ResultCard tone="neutral" icon={<Loader2 className="h-10 w-10 animate-spin" />} title="Loading…">
              <p />
            </ResultCard>
          }
        >
          <VerifyContent />
        </Suspense>
      </div>
    </div>
  );
}
