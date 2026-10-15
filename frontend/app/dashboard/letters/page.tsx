'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Download, Inbox, Mail, MailPlus, Search } from 'lucide-react';
import { listLetters, listOrgUnits } from '../../../features/letters/api';
import type { LetterSummary } from '../../../features/letters/types';
import { listDepartments } from '../../../features/documents/api';
import { PageHeader } from '../../../shared/components/PageHeader';
import { DataTable } from '../../../shared/components/DataTable';
import { StatusBadge } from '../../../shared/components/ui/StatusBadge';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { RequirePermission } from '../../../shared/components/RequirePermission';
import { usePermissions } from '../../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { useAuthStore } from '../../../state/auth.store';

function safeDate(value: unknown, fmt: string): string {
  if (!value) return '--';
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? '--' : format(d, fmt);
}

function csvCell(value: unknown) {
  const text = String(value ?? '').replace(/"/g, '""');
  return `"${text}"`;
}

type Tab = 'OUTGOING' | 'INCOMING';
const PAGE_SIZE = 10;

export default function LettersPage() {
  const router = useRouter();
  const { userId, role } = useAuthStore();
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>('OUTGOING');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [year, setYear] = useState('');
  const [letterType, setLetterType] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);

  // 30s, not 5 minutes — a department/org unit created moments ago must be
  // pickable the next time this page loads (same fix as useLookups.ts).
  const { data: unitsData } = useQuery({ queryKey: ['org-units'], queryFn: listOrgUnits, staleTime: 30_000 });
  const { data: deptsData } = useQuery({ queryKey: ['departments'], queryFn: listDepartments, staleTime: 30_000 });

  const query = useMemo(() => ({
    direction: tab,
    status: status || undefined,
    orgUnitId: orgUnitId || undefined,
    departmentId: departmentId || undefined,
    year: year ? Number(year) : undefined,
    letterType: letterType || undefined,
    q: q || undefined,
    overdue: overdueOnly || undefined,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  }), [tab, status, orgUnitId, departmentId, year, letterType, q, overdueOnly, page]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['letters', `${userId}:${role}`, query],
    queryFn: () => listLetters(query),
    enabled: Boolean(userId),
  });

  const letters = data?.data ?? [];
  const total = data?.total ?? letters.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetForTab = (next: Tab) => {
    setTab(next);
    setStatus('');
    setOverdueOnly(false);
    setPage(1);
  };

  const statusOptions =
    tab === 'OUTGOING'
      ? ['DRAFT', 'IN_REVIEW', 'RETURNED', 'PENDING_SIGNATURE', 'APPROVED', 'DISPATCHED', 'ARCHIVED', 'CANCELLED']
      : ['RECEIVED', 'RESPONDED', 'CLOSED', 'ARCHIVED'];

  const exportCsv = () => {
    const headers = ['Reference No.', 'Subject', 'Direction', 'Status', 'Unit', 'Department', 'Correspondent', 'Date', 'Due Date'];
    const rows = letters.map((row) => [
      row.referenceNumber ?? '(draft)',
      row.subject,
      row.direction,
      row.status,
      row.orgUnit?.code ?? '',
      row.department?.name ?? '',
      row.correspondent ?? '',
      safeDate(row.direction === 'INCOMING' ? row.receivedDate : (row.approvedAt ?? row.updatedAt), 'yyyy-MM-dd'),
      row.dueDate ? safeDate(row.dueDate, 'yyyy-MM-dd') : '',
    ]);
    const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `letters-${tab.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = [
    {
      key: 'referenceNumber',
      label: 'Reference No.',
      sortable: true,
      render: (_v: unknown, row: LetterSummary) => (
        <span className="font-mono text-[12px]" style={{ color: 'var(--text-primary)' }}>
          {row.referenceNumber ?? '-- (draft)'}
        </span>
      ),
    },
    {
      key: 'subject',
      label: 'Subject',
      sortable: true,
      render: (_v: unknown, row: LetterSummary) => (
        <span className="font-medium">{row.subject}</span>
      ),
    },
    {
      key: 'orgUnit',
      label: 'Unit',
      mobileLabel: 'Unit',
      render: (_v: unknown, row: LetterSummary) => row.orgUnit?.code ?? '--',
    },
    {
      key: 'department',
      label: 'Department',
      mobileHidden: true,
      render: (_v: unknown, row: LetterSummary) => row.department?.name ?? '--',
    },
    {
      key: 'correspondent',
      label: tab === 'OUTGOING' ? 'Recipient' : 'Sender',
      sortable: true,
      render: (_v: unknown, row: LetterSummary) => row.correspondent ?? '--',
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (_v: unknown, row: LetterSummary) => (
        <span className="inline-flex items-center gap-2">
          <StatusBadge status={row.isOverdue ? 'OVERDUE' : row.status} />
        </span>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      mobileHidden: true,
      render: (_v: unknown, row: LetterSummary) =>
        safeDate(row.direction === 'INCOMING' ? row.receivedDate : (row.approvedAt ?? row.updatedAt), 'dd MMM yyyy'),
    },
    {
      key: 'dueDate',
      label: 'Due',
      mobileHidden: tab === 'OUTGOING',
      render: (_v: unknown, row: LetterSummary) => row.dueDate ? safeDate(row.dueDate, 'dd MMM yyyy') : '--',
    },
  ];

  return (
    <RequirePermission permission={PERMISSIONS.LETTER_READ}>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Fixed header: title, tabs, filters stay on screen — only the
            table below scrolls internally (see the flex-1 min-h-0
            overflow-y-auto wrapper further down). */}
        <div className="mx-auto w-full max-w-7xl shrink-0 px-4 pt-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <PageHeader
              title="Correspondence"
              subtitle="Outgoing and incoming letters, approval, dispatch, response tracking, and the Group archive"
            />
            <div className="flex gap-2">
              <button onClick={exportCsv} disabled={letters.length === 0} className="ui-btn ui-btn-secondary">
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <PermissionGate permission={PERMISSIONS.LETTER_REGISTER}>
                <Link href="/dashboard/letters/register" className="ui-btn ui-btn-secondary">
                  <Inbox className="h-4 w-4" /> Register incoming
                </Link>
              </PermissionGate>
              <PermissionGate permission={PERMISSIONS.LETTER_CREATE}>
                <Link href="/dashboard/letters/new" className="ui-btn ui-btn-primary">
                  <MailPlus className="h-4 w-4" /> New letter
                </Link>
              </PermissionGate>
            </div>
          </div>

          <div className="mt-4 flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
            {(['OUTGOING', 'INCOMING'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => resetForTab(t)}
                className="px-4 py-2 text-[13px] font-medium rounded-t-md transition-colors"
                style={{
                  color: tab === t ? 'var(--brand-600)' : 'var(--text-muted)',
                  borderBottom: tab === t ? '2px solid var(--brand-600)' : '2px solid transparent',
                }}
              >
                {t === 'OUTGOING' ? 'Outgoing' : 'Incoming'}
              </button>
            ))}
          </div>

          <div className="ui-card mt-4 grid grid-cols-1 gap-3 md:grid-cols-6">
            <div className="relative md:col-span-2">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder="Search subject, ref no., correspondent"
                className="ui-input pl-8 w-full"
              />
            </div>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="ui-input w-full">
              <option value="">All statuses</option>
              {statusOptions.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <select
              value={orgUnitId}
              onChange={(e) => {
                const value = e.target.value;
                setOrgUnitId(value);
                // A department belongs to exactly one org unit -- drop a
                // department filter that no longer belongs to the newly
                // selected org unit, otherwise the two filters silently AND
                // into an impossible combination and the list just goes
                // empty with no visible explanation.
                if (departmentId && value) {
                  const stillValid = (deptsData ?? []).find((d) => d.id === departmentId)?.orgUnitId === value;
                  if (!stillValid) setDepartmentId('');
                }
                setPage(1);
              }}
              className="ui-input w-full"
            >
              <option value="">All units</option>
              {(unitsData?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.code} - {u.name}</option>)}
            </select>
            <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }} className="ui-input w-full">
              <option value="">All departments</option>
              {(deptsData ?? [])
                .filter((d) => !orgUnitId || d.orgUnitId === orgUnitId)
                .map((d) => <option key={d.id} value={d.id}>{d.code} - {d.name}</option>)}
            </select>
            <select value={letterType} onChange={(e) => { setLetterType(e.target.value); setPage(1); }} className="ui-input w-full">
              <option value="">All types</option>
              {['OUT', 'IN', 'MEMO', 'CIRC', 'CONT'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              value={year}
              onChange={(e) => { setYear(e.target.value.replace(/\D/g, '').slice(0, 4)); setPage(1); }}
              placeholder="Year"
              className="ui-input w-full"
            />
            {tab === 'INCOMING' && (
              <label className="inline-flex items-center gap-2 text-[13px] md:col-span-2" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={overdueOnly} onChange={(e) => { setOverdueOnly(e.target.checked); setPage(1); }} />
                Overdue only
              </label>
            )}
            {can(PERMISSIONS.LETTER_READ_ALL) && (
              <span className="text-[11px] px-2 py-1 rounded-full self-center w-fit" style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)' }}>
                Central Archive view
              </span>
            )}
          </div>

          {isError && (
            <div className="ui-card mt-4 p-0">
              <ErrorState error={error} title="Couldn't load letters" onRetry={() => refetch()} />
            </div>
          )}
        </div>

        {/* Scrollable region: only the table (and its pagination) scrolls
            internally within the remaining viewport height — the header,
            tabs, and filters above stay fixed in view. */}
        <div className="flex-1 min-h-0 overflow-y-auto ui-scrollbar">
          <div className="mx-auto max-w-7xl px-4 pb-6 sm:px-6">
            <div className="ui-card mt-4">
              <DataTable<LetterSummary>
                columns={columns}
                data={letters}
                isLoading={isLoading}
                mobileTitleKey="subject"
                mobileSubtitleKey="referenceNumber"
                onRowClick={(row) => router.push(`/dashboard/letters/${row.id}`)}
                emptyState={
                  <EmptyState
                    icon={Mail}
                    title={tab === 'OUTGOING' ? 'No outgoing letters' : 'No incoming letters'}
                    description={tab === 'OUTGOING' ? 'Draft a new letter to get started.' : 'Register incoming correspondence to file it into the archive.'}
                  />
                }
              />
              {total > PAGE_SIZE && (
                <PaginationControls
                  page={page}
                  onPageChange={setPage}
                  hasPrevious={page > 1}
                  hasNext={page * PAGE_SIZE < total}
                  totalPages={totalPages}
                  isLoading={isLoading}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </RequirePermission>
  );
}