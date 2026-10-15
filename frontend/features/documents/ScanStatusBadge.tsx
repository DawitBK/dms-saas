'use client';

import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

/**
 * Per-version antivirus result.
 *
 * The backend stores exactly two outcomes on a stored file (see
 * infrastructure/antivirus/clamscan.ts): `clean` means a scan actually ran
 * and found nothing, `unscanned` means the file was never verified — the
 * daemon was unreachable, or the scan itself errored. An infected file is
 * never one of these: it is rejected at upload and never stored.
 *
 * The distinction is worth a badge because the upload policy is fail-open. An
 * `unscanned` file looks identical to a clean one everywhere else in the app,
 * and the only previous signal was a toast at upload time that nobody sees
 * again. Anything other than `clean` is shown as a warning rather than hidden,
 * including an unrecognised value from an older row.
 */
export function ScanStatusBadge({
  status,
  className,
}: {
  status?: string | null;
  className?: string;
}) {
  if (!status) return null;
  const clean = status === 'clean';
  return (
    <span
      title={
        clean
          ? 'This file was scanned for viruses and came back clean.'
          : 'This file was NOT scanned — the virus scanner was unavailable when it was uploaded. It was stored anyway (fail-open policy).'
      }
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        clean ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800',
        className,
      )}
    >
      {clean ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
      {clean ? 'Scanned' : 'Not scanned'}
    </span>
  );
}
