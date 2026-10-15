'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { FileSignature, ArrowRight, Bell, Plus, XCircle, History } from 'lucide-react';
import { listSentSignatureRequests, remindSignatureRequest, cancelSignatureRequest } from '../../../../features/signing/internalApi';
import { signingErrorMessage } from '../../../../features/signing/errors';
import { SigningAuditTrail } from '../../../../features/signing/components/SigningAuditTrail';
import { StatusBadge } from '../../../../shared/components/ui/StatusBadge';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { EmptyState } from '../../../../shared/components/EmptyState';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { useUIStore } from '../../../../state/ui.store';

const PAGE_SIZE = 25;

function safeDate(value: unknown): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, 'MMM d, yyyy');
}

export default function SentSignaturesPage() {
  const qc = useQueryClient();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['signing', 'sent-by-me', page],
    queryFn: () => listSentSignatureRequests((page - 1) * PAGE_SIZE, PAGE_SIZE),
  });
  const remind = useMutation({
    mutationFn: (id: string) => remindSignatureRequest(id),
    onSuccess: () => { toast.success("Reminder sent. External signers get a fresh link; their earlier link no longer works."); qc.invalidateQueries({ queryKey: ['signing', 'sent-by-me'] }); },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Reminder failed')),
  });
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelSignatureRequest(id, reason.trim() || undefined),
    onSuccess: () => {
      toast.success('Signature request cancelled');
      setConfirmCancelId(null);
      setCancelReason('');
      qc.invalidateQueries({ queryKey: ['signing'] });
      qc.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (e: unknown) => toast.error(signingErrorMessage(e, 'Cancel failed')),
  });
  const requests = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar
        title="E-Signing"
        breadcrumbs={[{ label: 'E-Signing', href: '/dashboard/signing/pending' }, { label: 'Sent for Signature' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <div className="flex items-center justify-between mb-2">
          <PageHeader title="Sent for Signature" subtitle="Requests you've created, across every document." />
          <Link href="/dashboard/signing" className="ui-btn ui-btn-primary shrink-0"><Plus size={16} /> New request</Link>
        </div>

        {isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
        ) : requests.length === 0 ? (
          <EmptyState icon={FileSignature} title="No requests sent yet" description="Create a signature request from a document's Governance tab, or from here." />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="ui-card">
                <div className="flex items-center gap-3">
                  <FileSignature size={18} style={{ color: 'var(--text-tertiary)' }} className="shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {r.document?.documentName ?? r.document?.title ?? 'Document'}
                      </span>
                      <StatusBadge status={r.status.toUpperCase()} />
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      Sent {safeDate(r.createdAt)} · {(r.recipients ?? []).filter((rec) => rec.status === 'signed').length}/{(r.recipients ?? []).length} signed
                    </p>
                  </div>
                  {['sent', 'partially_signed'].includes(r.status) && (
                    <button onClick={() => remind.mutate(r.id)} disabled={remind.isPending} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">
                      <Bell size={13} /> Remind
                    </button>
                  )}
                  {['draft', 'sent', 'partially_signed'].includes(r.status) && (
                    confirmCancelId === r.id ? (
                      <>
                        <input
                          value={cancelReason}
                          onChange={(e) => setCancelReason(e.target.value)}
                          maxLength={500}
                          placeholder="Reason (optional)"
                          aria-label="Reason for cancelling"
                          className="ui-input !py-1 text-xs w-44 shrink-0"
                        />
                        <button onClick={() => cancel.mutate({ id: r.id, reason: cancelReason })} disabled={cancel.isPending} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">Confirm cancel</button>
                        <button onClick={() => { setConfirmCancelId(null); setCancelReason(''); }} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">Keep</button>
                      </>
                    ) : (
                      <button onClick={() => { setConfirmCancelId(r.id); setCancelReason(''); }} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">
                        <XCircle size={13} /> Cancel request
                      </button>
                    )
                  )}
                  <button
                    onClick={() => setHistoryId(historyId === r.id ? null : r.id)}
                    aria-expanded={historyId === r.id}
                    className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0"
                  >
                    <History size={13} /> History
                  </button>
                  {r.document?.id && (
                    <Link href={`/dashboard/signing?documentId=${r.document.id}`} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">
                      Manage <ArrowRight size={13} />
                    </Link>
                  )}
                </div>
                {historyId === r.id && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                    <SigningAuditTrail requestId={r.id} />
                  </div>
                )}
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
    </>
  );
}
