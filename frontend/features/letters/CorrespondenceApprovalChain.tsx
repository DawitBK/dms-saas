import Link from 'next/link';
import { format } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import { StatusBadge } from '../../shared/components/ui/StatusBadge';
import type { LetterDetail } from './types';

// ─── Correspondence (letter) approval chain ────────────────────────────────
// CORR documents are a letter's filed final PDF/attachment/cover sheet.
// Letters run their own approval chain (letter_approval_steps), entirely
// separate from the unified engine ApprovalChainCard queries — this renders
// that real chain (every review/approve step and who decided it) so the
// Workflow tab stops claiming "not submitted yet" on a letter that's
// already been fully approved, signed, and archived.
//
// Extracted from app/dashboard/documents/[id]/page.tsx so it's testable in
// isolation (see CorrespondenceApprovalChain.test.tsx) — this is the exact
// feature the "lazy workflow" complaint was about: every approval/signing
// step and who did it, in detail.
export function CorrespondenceApprovalChain({ letter }: { letter: LetterDetail }) {
  const steps = letter.approvalSteps ?? [];
  return (
    <div className="ui-card mt-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Correspondence approval chain
        </p>
        <Link href={`/dashboard/letters/${letter.id}`} className="inline-flex items-center gap-0.5 text-[12px] font-semibold" style={{ color: 'var(--brand-600)' }}>
          View full letter <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <p className="text-sm text-text-muted mb-3">
        This document is the filed record of letter <span className="font-mono">{letter.referenceNumber ?? letter.subject}</span> — it went
        through the correspondence module&apos;s own review/approve chain below, not the unified engine this tab otherwise checks.
      </p>
      {steps.length === 0 ? (
        <p className="text-sm text-text-muted">No approval chain exists for this letter yet.</p>
      ) : (
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
              <span className="text-[12px] font-mono w-6" style={{ color: 'var(--text-muted)' }}>#{s.stepOrder}</span>
              <span className="text-[13px] font-medium">{s.stepType === 'APPROVE' ? 'Approve and sign' : 'Review'}</span>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                to {s.assignedUser ? `${s.assignedUser.firstName} ${s.assignedUser.lastName} (${s.assignedUser.email})` : s.assignedRole ? s.assignedRole.replace(/_/g, ' ') : 'named user'}
              </span>
              <StatusBadge status={s.status} />
              {/* The step's "to" above is who it was OWED to — for a
                  role-assigned step (assignedUser null, assignedRole set)
                  that's a generic role, not a person. decidedByUser is the
                  specific individual who actually acted, regardless of how
                  the step was assigned. */}
              {s.decidedByUser && (
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  — decided by {s.decidedByUser.firstName} {s.decidedByUser.lastName} ({s.decidedByUser.email})
                </span>
              )}
              {s.comment && <span className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>{s.comment}</span>}
              {s.decidedAt && <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>{format(new Date(s.decidedAt), 'PPp')}</span>}
            </li>
          ))}
        </ul>
      )}
      {(letter.dispatches ?? []).length > 0 && (
        <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <p className="text-[12px] font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Dispatch</p>
          <ul className="space-y-1.5">
            {(letter.dispatches ?? []).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                <span className="font-medium">{d.channel.replace(/_/g, ' ')}</span>
                {d.recipientName && <span style={{ color: 'var(--text-muted)' }}>to {d.recipientName}</span>}
                {d.dispatcher && <span style={{ color: 'var(--text-muted)' }}>by {d.dispatcher.firstName} {d.dispatcher.lastName}</span>}
                <span style={{ color: 'var(--text-muted)' }}>{format(new Date(d.dispatchedAt), 'PPp')}</span>
                {d.acknowledgedAt && <span className="text-emerald-600 text-[12px]">acknowledged {format(new Date(d.acknowledgedAt), 'PPp')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
