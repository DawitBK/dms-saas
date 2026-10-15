'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { FileSignature, History } from 'lucide-react';
import { listAllSignatureRequests } from '../../../../features/signing/internalApi';
import { SigningAuditTrail } from '../../../../features/signing/components/SigningAuditTrail';
import { signingErrorMessage } from '../../../../features/signing/errors';
import { StatusBadge } from '../../../../shared/components/ui/StatusBadge';
import { TopBar } from '../../../../shared/components/TopBar';
import { PageHeader } from '../../../../shared/components/PageHeader';
import { EmptyState } from '../../../../shared/components/EmptyState';
import { PaginationControls } from '../../../../shared/components/ui/PaginationControls';
import { useUIStore } from '../../../../state/ui.store';
import { usePermissions } from '../../../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../../../shared/lib/permissions';

const PAGE_SIZE = 25;
const STATUSES = ['draft', 'sent', 'partially_signed', 'completed', 'voided', 'expired'] as const;

function safeDate(value: unknown): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, 'MMM d, yyyy');
}

/** Tenant-wide, read-only view of every signature request, for oversight roles (document:read_all). */
export default function SigningOverviewPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const { can } = usePermissions();
  const mayRead = can(PERMISSIONS.DOCUMENT_READ_ALL);
  const { data, isLoading, error } = useQuery({
    enabled: mayRead,
    queryKey: ['signing', 'overview', page, status, search],
    queryFn: () => listAllSignatureRequests({ skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, status: status || undefined, q: search || undefined }),
  });
  const requests = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar
        title="E-Signing"
        breadcrumbs={[{ label: 'E-Signing', href: '/dashboard/signing/pending' }, { label: 'All requests' }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <PageHeader title="All signature requests" subtitle="Every request in your organisation, with its status and history. Read-only." />

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            type="search"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by document name or title"
            aria-label="Search signature requests"
            className="ui-input max-w-xs"
          />
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            aria-label="Filter by status"
            className="ui-input max-w-[12rem]"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>

        {!mayRead ? (
          <div role="alert" className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
            This list is for oversight roles. You can see the signature requests you sent or must sign under E-Signing.
          </div>
        ) : isLoading ? (
          <div className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
        ) : error ? (
          <div role="alert" className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
            {signingErrorMessage(error, 'Could not load signature requests')}
          </div>
        ) : requests.length === 0 ? (
          <EmptyState icon={FileSignature} title="No signature requests" description="Nothing matches these filters." />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => {
              const recipients = r.recipients ?? [];
              const open = openId === r.id;
              return (
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
                        {r.createdByName ?? 'Unknown requester'} · {safeDate(r.createdAt)} · {recipients.filter((x) => x.status === 'signed').length}/{recipients.length} signed
                        {r.voidedReason ? ` · ${r.voidedReason}` : ''}
                      </p>
                      {recipients.length > 0 && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {recipients.map((x) => `${x.name} (${x.status})`).join(', ')}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => setOpenId(open ? null : r.id)}
                      aria-expanded={open}
                      className="ui-btn ui-btn-secondary !py-1.5 text-xs shrink-0"
                    >
                      <History size={13} /> {open ? 'Hide history' : 'History'}
                    </button>
                  </div>
                  {open && <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)' }}><SigningAuditTrail requestId={r.id} /></div>}
                </div>
              );
            })}
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
