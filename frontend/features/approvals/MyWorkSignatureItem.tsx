import Link from 'next/link';
import { format } from 'date-fns';
import type { MyWork } from './api';

function safeDate(value: unknown, fmt = 'MMM d, yyyy'): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

// Extracted from app/dashboard/mywork/page.tsx so the routing fix below is
// unit-testable in isolation (see MyWorkSignatureItem.test.tsx) — a real
// regression reported live: this item used to link to
// `/dashboard/signing?documentId=...` (the create/manage hub, gated behind
// SIGNING_MANAGE) instead of the self-service "sign now" list, so a plain
// signer clicking their own pending signature landed on a page they had no
// permission to use.
export function MyWorkSignatureItem({ signature }: { signature: MyWork['signatures'][number] }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
      {/* This is the signer's OWN pending task, not a signing request to
          set up/manage — always send it to Pending My Signature (the
          self-service "sign now" list), never the /dashboard/signing hub.
          That hub is the create/manage flow and is gated behind
          SIGNING_MANAGE — a plain signer landing there got the wrong page
          entirely, not just an inconvenient one. */}
      <Link
        href="/dashboard/signing/pending"
        className="text-sm font-semibold hover:text-brand-600 truncate max-w-[55%]"
      >
        {signature.document?.title ?? '(document)'}
      </Link>
      <span className="text-[11px] uppercase font-bold text-slate-500">{signature.status}</span>
      <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>since {safeDate(signature.createdAt)}</span>
    </li>
  );
}
