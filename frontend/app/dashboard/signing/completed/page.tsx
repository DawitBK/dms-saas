'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { listCompletedSignatureRequests } from '../../../../features/signing/internalApi';
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

export default function CompletedSignaturesPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['signing', 'completed', page],
    queryFn: () => listCompletedSignatureRequests((page - 1) * PAGE_SIZE, PAGE_SIZE),
  });
  const requests = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar
        title="E-Signing"
        breadcrumbs={[{ label: 'E-Signing', href: '/dashboard/signing/pending' }, { label: 'Completed' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader title="Completed" subtitle="Signature ceremonies you sent or took part in that have finished." />

        {isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
        ) : requests.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Nothing completed yet" description="Finished signature ceremonies will show up here." />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="ui-card flex items-center gap-3">
                <CheckCircle2 size={18} style={{ color: 'var(--color-green-500, #22c55e)' }} className="shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.document?.documentName ?? r.document?.title ?? 'Document'}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    Completed {safeDate(r.completedAt)} · {(r.recipients ?? []).length} signer{(r.recipients ?? []).length === 1 ? '' : 's'}
                  </p>
                </div>
                {r.document?.id && (
                  <Link href={`/dashboard/documents/${r.document.id}`} className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0">
                    Open document <ArrowRight size={13} />
                  </Link>
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
