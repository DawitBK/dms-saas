'use client';

// "My Work" — the unified inbox: every
// pending approval step (documents, forms, letters), e-sign request, audit
// review, and assigned incoming letter in one place.

import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare, FileSignature, Inbox, Mail, ShieldCheck } from 'lucide-react';
import { getMyWork } from '../../../features/approvals/api';
import { MyWorkSignatureItem } from '../../../features/approvals/MyWorkSignatureItem';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { EmptyState } from '../../../shared/components/EmptyState';
import { useUIStore } from '../../../state/ui.store';
import { fallbackPollInterval, useRealtimeStore } from '../../../state/realtime.store';

function safeDate(value: unknown, fmt = 'MMM d, yyyy'): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

function QueueCard(props: { title: string; icon: React.ElementType; count: number; children: React.ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="ui-card">
      <h2 className="flex items-center gap-2 text-sm font-bold mb-3">
        <Icon className="h-4 w-4 text-brand-600" /> {props.title}
        <span className="text-xs px-1.5 py-0.5 rounded-full font-bold bg-brand-100 text-brand-700">{props.count}</span>
      </h2>
      {props.children}
    </div>
  );
}

export default function MyWorkPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  // F-06: this used to poll every 60s unconditionally, on the endpoint the
  // audit register flagged as the hottest in the system. It did not need to:
  // RealtimeBridge already invalidates ["my-work"] on
  // APPROVAL_CHAIN.UPDATED, SIGNING.UPDATED, LETTER.ASSIGNED and
  // LETTER.STEP_PENDING, all delivered through the transactional outbox, so
  // new work already arrived without waiting for the interval.
  //
  // The interval survives only as a FALLBACK for a socket that is down —
  // a dropped idle upgrade at the proxy, a Redis outage taking the socket.io
  // adapter with it, a laptop resumed from sleep mid-reconnect. Showing an
  // approver a silently stale inbox is worse than a redundant request, but
  // paying for that request when the socket is healthy is pure waste.
  const socketConnected = useRealtimeStore((s) => s.connected);
  const { data, isLoading } = useQuery({
    queryKey: ['my-work'],
    queryFn: getMyWork,
    refetchInterval: fallbackPollInterval(socketConnected),
  });

  const approvals = data?.approvals ?? [];
  const signatures = data?.signatures ?? [];
  const audits = data?.audits ?? [];
  const letters = data?.letters ?? [];
  const total = approvals.length + signatures.length + audits.length + letters.length;

  return (
    <>
      <TopBar
        title="My Work"
        breadcrumbs={[{ label: 'Repository', href: '/dashboard' }, { label: 'My Work' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader title="My Work" subtitle="Everything waiting on you — approvals, signatures, audits, and assigned correspondence" />

        {!isLoading && total === 0 && (
          <EmptyState icon={Inbox} title="All clear" description="Nothing is waiting on you right now." />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <QueueCard title="Approvals" icon={CheckSquare} count={approvals.length}>
            {approvals.length === 0 ? (
              <p className="text-sm text-text-muted">No approval steps waiting on you.</p>
            ) : (
              <ul className="space-y-2">
                {approvals.map((a) => {
                  const isLetter = a.kind === 'LETTER';
                  const isFormTemplate = !isLetter && a.itemType === 'FORM_TEMPLATE';
                  const href = isLetter
                    ? `/dashboard/letters/${a.letterId}`
                    : isFormTemplate
                      ? `/dashboard/forms/templates?highlight=${a.itemId}`
                      : a.documentId ? `/dashboard/documents/${a.documentId}?tab=workflow` : '#';
                  // Who submitted it — already fetched (approvals.service.ts joins
                  // the chain's submitter), just never rendered. Without this, every
                  // row named the document but never who was waiting on the caller
                  // to act, or who they'd be acting on behalf of.
                  // Null when the submitter is the hidden platform administrator (redacted server side).
                  const submitter = (a as any).chain?.submitter as { firstName?: string; lastName?: string } | null | undefined;
                  // The step is overdue and was escalated to the caller: they may decide it although it is not theirs.
                  const escalatedToMe = a.escalatedToMe === true;
                  const submittedAt = new Date(String(a.createdAt));
                  const elapsed = !isNaN(submittedAt.getTime()) ? formatDistanceToNow(submittedAt, { addSuffix: true }) : null;
                  return (
                    <li key={String(a.id)} className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                      <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">{isLetter ? 'Letter' : isFormTemplate ? 'Form template' : 'Document'}</span>
                      <Link href={href} className="text-sm font-semibold hover:text-brand-600 truncate max-w-[45%]">
                        {String(a.title ?? '(untitled)')}
                      </Link>
                      {escalatedToMe && (
                        <span
                          className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700"
                          title="This step is overdue and was escalated to you. You can decide it although it is assigned to someone else."
                          data-testid="escalated-to-you"
                        >
                          Escalated to you
                        </span>
                      )}
                      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        {String(a.stepType)}{a.stepOrder != null ? ` · step ${a.stepOrder}` : ''}
                        {submitter ? ` · from ${submitter.firstName ?? ''} ${submitter.lastName ?? ''}`.trimEnd() : ''}
                      </span>
                      {Boolean(a.dueAt) && (
                        <span className={`text-[11px] ${new Date(String(a.dueAt)) < new Date() ? 'text-red-600 font-semibold' : ''}`}>due {safeDate(a.dueAt)}</span>
                      )}
                      <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }} title={safeDate(a.createdAt, 'PPp')}>
                        {elapsed ? `waiting ${elapsed}` : `since ${safeDate(a.createdAt)}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueueCard>

          <QueueCard title="Signatures" icon={FileSignature} count={signatures.length}>
            {signatures.length === 0 ? (
              <p className="text-sm text-text-muted">No signature requests waiting on you.</p>
            ) : (
              <ul className="space-y-2">
                {signatures.map((s) => (
                  <MyWorkSignatureItem key={s.recipientId} signature={s} />
                ))}
              </ul>
            )}
          </QueueCard>

          <QueueCard title="Audits" icon={ShieldCheck} count={audits.length}>
            {audits.length === 0 ? (
              <p className="text-sm text-text-muted">No items pending your audit review.</p>
            ) : (
              <ul className="space-y-2">
                {audits.map((a) => {
                  const doc = a.document as { id?: string; title?: string } | null;
                  const assigner = (a as any).assigner as { firstName?: string; lastName?: string } | undefined;
                  return (
                    <li key={String(a.id)} className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                      <Link href={doc?.id ? `/dashboard/documents/${doc.id}?tab=workflow` : '#'} className="text-sm font-semibold hover:text-brand-600 truncate max-w-[55%]">
                        {doc?.title ?? '(document)'}
                      </Link>
                      {assigner && (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          assigned by {assigner.firstName ?? ''} {assigner.lastName ?? ''}
                        </span>
                      )}
                      <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>assigned {safeDate(a.createdAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueueCard>

          <QueueCard title="Assigned correspondence" icon={Mail} count={letters.length}>
            {letters.length === 0 ? (
              <p className="text-sm text-text-muted">No incoming letters assigned to you.</p>
            ) : (
              <ul className="space-y-2">
                {letters.map((l) => (
                  <li key={String(l.id)} className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
                    <Link href={`/dashboard/letters/${l.id}`} className="text-sm font-semibold hover:text-brand-600 truncate max-w-[45%]">
                      {String(l.subject ?? '(letter)')}
                    </Link>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{String(l.referenceNumber ?? '')}</span>
                    {Boolean(l.isOverdue) && <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700">Overdue</span>}
                    {Boolean(l.dueDate) && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>due {safeDate(l.dueDate)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </QueueCard>
        </div>
      </div>
    </>
  );
}
