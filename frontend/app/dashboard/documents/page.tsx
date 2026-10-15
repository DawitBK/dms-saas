'use client';

// Filtered documents list — the destination for dashboard/operations stat cards.
// Backed by GET /documents (the SAME tenant-scoped query the dashboard stats use
// via getDashboardStats/scopeWhere), so a card showing "Active: 53" links here and
// the count matches exactly — unlike /search, which post-filters by ACL.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { format } from 'date-fns';
import { Files, ArrowLeft } from 'lucide-react';
import { listDocuments } from '../../../features/documents/api';
import { useAuthStore } from '../../../state/auth.store';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { DataTable } from '../../../shared/components/DataTable';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { FileTypeIcon } from '../../../shared/components/FileTypeIcon';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { useUIStore } from '../../../state/ui.store';
import { useResetOnChange } from '../../../shared/hooks/useResetOnChange';

const PAGE_SIZE = 25;

// Friendly title/description per known filter, so the page reads as
// "Active Documents" rather than a raw status string.
function describeFilter(status: string, q: string, tenantWideRead: boolean): { title: string; subtitle: string } {
  const s = status.toUpperCase();
  if (q) return { title: 'Documents', subtitle: `Matching "${q}"` };
  if (!status) {
    return tenantWideRead
      ? { title: 'All Documents', subtitle: 'Every document in your tenant' }
      : { title: 'My Scope', subtitle: 'Documents in your assigned departments' };
  }
  if (s === 'ACTIVE') return { title: 'Active Documents', subtitle: 'Documents currently active' };
  if (s === 'ARCHIVED') return { title: 'Archived Documents', subtitle: 'Documents moved to the archive' };
  if (s === 'DISPOSAL_PENDING') return { title: 'Disposal Pending', subtitle: 'Documents awaiting disposal authorisation' };
  if (s.includes('PENDING_REVIEW') || s.includes('IN_REVIEW'))
    return { title: 'Pending Review', subtitle: 'Documents awaiting or under review' };
  return { title: 'Documents', subtitle: `Filtered by status: ${status.replace(/,/g, ', ')}` };
}

function DocumentsListInner() {
  const router = useRouter();
  const params = useSearchParams();
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const { userId, role, permissions } = useAuthStore();

  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const [page, setPage] = useState(1);
  // Keyset (cursor) pagination: offset/limit alone can skip or repeat a row
  // when the underlying table is written to between page fetches (this list
  // is backed by a table with continuous outbox-driven writes — indexing,
  // OCR — alongside ordinary uploads). cursorForPage[p] is the cursor that
  // fetches page p+1, learned from page p's own response; since
  // PaginationControls only ever moves one page at a time, the cursor for
  // any page we navigate to has always already been recorded on the way
  // there.
  const [cursorForPage, setCursorForPage] = useState<Record<number, string>>({});

  // A filter change invalidates every recorded cursor (they were computed
  // against the OLD filtered set) — reset back to page 1 rather than risk
  // reusing one against the new filters.
  useResetOnChange([status, q, departmentId], () => {
    setPage(1);
    setCursorForPage({});
  });

  const cursor = page > 1 ? cursorForPage[page - 1] : undefined;

  const { title, subtitle } = describeFilter(
    status,
    q,
    permissions.includes(PERMISSIONS.DOCUMENT_READ_ALL),
  );

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['documents-list', status, q, departmentId, page, cursor],
    queryFn: () =>
      listDocuments((page - 1) * PAGE_SIZE, PAGE_SIZE, {
        status: status || undefined,
        q: q || undefined,
        departmentId: departmentId || undefined,
        cursor,
      }),
    enabled: Boolean(userId && role),
    staleTime: 30_000,
  });

  useResetOnChange([data?.nextCursor, page], () => {
    if (data?.nextCursor) {
      setCursorForPage((prev) => (prev[page] === data.nextCursor ? prev : { ...prev, [page]: data.nextCursor! }));
    }
  });

  const docs = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    {
      key: 'type',
      label: '',
      render: (_v: unknown, row: any) => (
        <FileTypeIcon mimeType={row?.versions?.[0]?.mimeType || ''} size={18} />
      ),
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      render: (_v: unknown, row: any) => (
        <Link
          href={`/dashboard/documents/${row.id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-semibold text-text-primary hover:text-brand-600"
        >
          {row.title}
          {row.currentVersion && (
            <span className="text-[10px] font-mono text-text-muted ml-1">v{row.currentVersion}</span>
          )}
        </Link>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      // D4: one IN_REVIEW chip + a progress hint ("2/3 · waiting on X") — no
      // extra sub-state on lists; the full stepper lives on the detail page.
      render: (_v: unknown, row: any) => (
        <span className="inline-flex items-center gap-2">
          <StatusBadge status={row.status} />
          {row.approvalProgress && (
            <span className="text-[11px] text-text-muted whitespace-nowrap">
              {row.approvalProgress.done}/{row.approvalProgress.total}
              {row.approvalProgress.waitingOn ? ` · waiting on ${row.approvalProgress.waitingOn}` : ''}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'department',
      label: 'Department',
      mobileLabel: 'Dept',
      render: (_v: unknown, row: any) => (
        <span className="text-xs text-text-secondary">{row.department?.name ?? '—'}</span>
      ),
    },
    {
      key: 'updatedAt',
      label: 'Modified',
      sortable: true,
      render: (_v: unknown, row: any) => {
        const d = row.updatedAt ? new Date(row.updatedAt) : null;
        return d && !isNaN(d.getTime()) ? format(d, 'MMM d, yyyy') : '—';
      },
    },
  ];

  return (
    <>
      <TopBar
        title={title}
        breadcrumbs={[{ label: 'Repository', href: '/dashboard' }, { label: title }]}
        onMobileMenuToggle={toggleSidebar}
      />
      <div className="flex-1 overflow-y-auto min-h-0 p-6">
        <div className="flex items-center gap-3 mb-1">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-brand-600"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
        </div>
        <PageHeader
          title={title}
          subtitle={isLoading ? subtitle : `${subtitle} · ${total.toLocaleString()} document${total === 1 ? '' : 's'}`}
        />

        {isError && (
          <div className="ui-card mb-6 p-0">
            <ErrorState error={error} title="Couldn't load documents" onRetry={() => refetch()} />
          </div>
        )}

        <DataTable
          columns={columns}
          data={docs}
          isLoading={isLoading}
          mobileTitleKey="title"
          mobileSubtitleKey="updatedAt"
          onRowClick={(row: any) => router.push(`/dashboard/documents/${row.id}`)}
          emptyState={
            <EmptyState
              icon={Files}
              title="No documents match"
              description="Nothing here for this filter. Try a different status or clear the filter."
            />
          }
        />

        {total > PAGE_SIZE && (
          <PaginationControls
            page={page}
            totalPages={totalPages}
            hasPrevious={page > 1}
            hasNext={Boolean(data?.nextCursor)}
            onPageChange={setPage}
            isLoading={isLoading}
          />
        )}
      </div>
    </>
  );
}

export default function DocumentsListPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsListInner />
    </Suspense>
  );
}
