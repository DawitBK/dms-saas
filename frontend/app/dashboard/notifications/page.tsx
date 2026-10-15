'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Bell,
  CheckCheck,
  Workflow,
  FileText,
  ShieldAlert,
  Info,
  FileSignature,
  AlertOctagon,
  Cpu,
  ServerCrash,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { apiClient } from '../../../shared/lib/apiClient';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { EmptyState } from '../../../shared/components/EmptyState';
import { PaginationControls } from '../../../shared/components/ui/PaginationControls';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { useUIStore } from '../../../state/ui.store';
import { cn } from '../../../shared/lib/cn';

type NotifType =
  | 'WORKFLOW' | 'DOCUMENT' | 'SYSTEM' | 'LEGAL_HOLD'
  | 'LETTER_STEP_PENDING' | 'LETTER_REGISTERED' | 'LETTER_APPROVED' | 'LETTER_SIGNED' | 'LETTER_RETURNED' | 'LETTER_RECALLED' | 'LETTER_SLA_BREACH' | 'LETTER_STEP_ESCALATED' | 'LETTER_CANCELLED'
  // Unified approval engine + audit stage + SLA/offboarding escalations (L2)
  | 'APPROVAL_STEP_PENDING' | 'APPROVAL_CHANGES_REQUESTED' | 'APPROVAL_DECLINED' | 'APPROVAL_COMPLETED' | 'APPROVAL_CANCELLED'
  | 'AUDIT_STAGE_ASSIGNED' | 'AUDIT_STAGE_PASSED' | 'AUDIT_STAGE_FLAGGED'
  | 'APPROVAL_SLA_BREACH' | 'ASSIGNEE_DEACTIVATED'
  // A step handed to you, an overdue step escalated to you, a form recalled from review by its filer.
  | 'APPROVAL_STEP_DELEGATED' | 'APPROVAL_STEP_ESCALATED' | 'APPROVAL_WITHDRAWN'
  | 'ESIGN_REQUEST_ASSIGNED' | 'ESIGN_REQUEST_DECLINED' | 'ESIGN_REQUEST_COMPLETED'
  // Observability follow-up: these two rendered with the generic Info
  // fallback icon/color and (for OUTBOX_DEAD_LETTER) a dead, non-navigable
  // click — the body text said "retry it from Operations → Outbox" but
  // clicking did nothing. Both now have real icons/colors and deep links.
  | 'OUTBOX_DEAD_LETTER' | 'AI_PROCESSING_SKIPPED'
  // DATA-3: fanned out once, platform-wide, when every background worker
  // (retention purge, legal-hold disposal, SLA escalation) is offline
  // because REDIS_URL was unset/unreachable at boot.
  | 'WORKERS_OFFLINE';

const TYPE_ICONS: Record<NotifType, React.ElementType> = {
  WORKFLOW: Workflow,
  DOCUMENT: FileText,
  LEGAL_HOLD: ShieldAlert,
  SYSTEM: Info,
  LETTER_STEP_PENDING: FileText,
  LETTER_REGISTERED: FileText,
  LETTER_APPROVED: FileText,
  LETTER_SIGNED: FileSignature,
  LETTER_RETURNED: FileText,
  LETTER_RECALLED: FileText,
  LETTER_SLA_BREACH: ShieldAlert,
  LETTER_STEP_ESCALATED: ShieldAlert,
  LETTER_CANCELLED: FileText,
  APPROVAL_STEP_PENDING: Workflow,
  APPROVAL_CHANGES_REQUESTED: Workflow,
  APPROVAL_DECLINED: Workflow,
  APPROVAL_COMPLETED: Workflow,
  APPROVAL_CANCELLED: Workflow,
  AUDIT_STAGE_ASSIGNED: ShieldAlert,
  AUDIT_STAGE_PASSED: ShieldAlert,
  AUDIT_STAGE_FLAGGED: ShieldAlert,
  APPROVAL_SLA_BREACH: ShieldAlert,
  APPROVAL_STEP_DELEGATED: Workflow,
  APPROVAL_STEP_ESCALATED: ShieldAlert,
  APPROVAL_WITHDRAWN: Workflow,
  ASSIGNEE_DEACTIVATED: ShieldAlert,
  ESIGN_REQUEST_ASSIGNED: FileSignature,
  ESIGN_REQUEST_DECLINED: FileSignature,
  ESIGN_REQUEST_COMPLETED: FileSignature,
  OUTBOX_DEAD_LETTER: AlertOctagon,
  AI_PROCESSING_SKIPPED: Cpu,
  WORKERS_OFFLINE: ServerCrash,
};
const TYPE_COLORS: Record<NotifType, string> = {
  WORKFLOW: 'bg-indigo-500/10 text-indigo-500',
  DOCUMENT: 'bg-blue-500/10 text-blue-500',
  LEGAL_HOLD: 'bg-red-500/10 text-red-500',
  SYSTEM: 'bg-surface-raised text-text-muted',
  LETTER_STEP_PENDING: 'bg-cyan-500/10 text-cyan-600',
  LETTER_REGISTERED: 'bg-cyan-500/10 text-cyan-600',
  LETTER_APPROVED: 'bg-green-500/10 text-green-600',
  LETTER_SIGNED: 'bg-green-500/10 text-green-600',
  LETTER_RETURNED: 'bg-amber-500/10 text-amber-600',
  LETTER_RECALLED: 'bg-gray-500/10 text-gray-500',
  LETTER_SLA_BREACH: 'bg-amber-500/10 text-amber-600',
  LETTER_STEP_ESCALATED: 'bg-red-500/10 text-red-600',
  LETTER_CANCELLED: 'bg-gray-500/10 text-gray-500',
  APPROVAL_STEP_PENDING: 'bg-indigo-500/10 text-indigo-500',
  APPROVAL_CHANGES_REQUESTED: 'bg-amber-500/10 text-amber-600',
  APPROVAL_DECLINED: 'bg-red-500/10 text-red-500',
  APPROVAL_COMPLETED: 'bg-green-500/10 text-green-600',
  APPROVAL_CANCELLED: 'bg-gray-500/10 text-gray-500',
  AUDIT_STAGE_ASSIGNED: 'bg-violet-500/10 text-violet-600',
  AUDIT_STAGE_PASSED: 'bg-green-500/10 text-green-600',
  AUDIT_STAGE_FLAGGED: 'bg-red-500/10 text-red-500',
  APPROVAL_SLA_BREACH: 'bg-red-500/10 text-red-500',
  APPROVAL_STEP_DELEGATED: 'bg-indigo-500/10 text-indigo-500',
  APPROVAL_STEP_ESCALATED: 'bg-red-500/10 text-red-500',
  APPROVAL_WITHDRAWN: 'bg-amber-500/10 text-amber-600',
  ASSIGNEE_DEACTIVATED: 'bg-amber-500/10 text-amber-600',
  ESIGN_REQUEST_ASSIGNED: 'bg-cyan-500/10 text-cyan-600',
  ESIGN_REQUEST_DECLINED: 'bg-red-500/10 text-red-500',
  ESIGN_REQUEST_COMPLETED: 'bg-green-500/10 text-green-600',
  OUTBOX_DEAD_LETTER: 'bg-red-500/10 text-red-500',
  AI_PROCESSING_SKIPPED: 'bg-amber-500/10 text-amber-600',
  WORKERS_OFFLINE: 'bg-red-500/10 text-red-500',
};

type NotifTab = 'all' | 'unread' | 'workflow' | 'system';

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const router = useRouter();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<NotifTab>('all');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiClient<{ data: any[] }>('/notifications'),
    staleTime: 10_000, // 10 seconds
  });

  const markRead = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/notifications/${id}/read`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not mark as read'),
  });

  const markAllRead = useMutation({
    mutationFn: () => apiClient('/notifications/read-all', { method: 'PATCH' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success('All notifications marked as read');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not mark all as read'),
  });

  const notifications: any[] = data?.data ?? [];
  const unread = notifications.filter((n) => !n.readAt).length;

  const filteredNotifs = notifications.filter((n: any) => {
    if (activeTab === 'unread') return !n.readAt;
    if (activeTab === 'workflow') return n.type === 'WORKFLOW';
    if (activeTab === 'system') return n.type === 'SYSTEM';
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredNotifs.length / PAGE_SIZE));
  const paged = filteredNotifs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleTabChange = (t: NotifTab) => {
    setActiveTab(t);
    setPage(1);
  };
  const notificationHref = (n: any) => {
    const payload = n.payload ?? n.metadata ?? n.data ?? {};
    const documentId = n.documentId ?? payload.documentId;
    const letterId = n.letterId ?? payload.letterId;
    if (letterId || String(n.type ?? '').startsWith('LETTER')) return letterId ? `/dashboard/letters/${letterId}` : '/dashboard/letters';
    const t = String(n.type ?? '');
    if (documentId) {
      // FIX: these used to always land on Overview — a click from "your
      // approval step is pending" required an extra manual click into the
      // Workflow tab to actually see or act on it, unlike the equivalent My
      // Work link below which already deep-links correctly.
      if (t.startsWith('APPROVAL') || t.startsWith('AUDIT_STAGE')) return `/dashboard/documents/${documentId}?tab=workflow`;
      if (t.startsWith('ESIGN')) return `/dashboard/documents/${documentId}?tab=governance`;
      return `/dashboard/documents/${documentId}`;
    }
    if (n.type === 'WORKFLOW') return '/operations?panel=workflows';
    if (n.type === 'LEGAL_HOLD') return '/operations?panel=legalHold';
    // FIX: OUTBOX_DEAD_LETTER's body text has always said "retry it from
    // Operations → Outbox", but this function never had a case for it, so
    // documentId was null (dead-lettered outbox rows aren't always tied to a
    // document) and it fell through to the final `return null` — the click
    // did nothing despite the explicit instruction in the notification itself.
    if (n.type === 'OUTBOX_DEAD_LETTER') return '/operations?panel=outbox';
    // DATA-3: no dedicated panel for this (rare, config-level) alert — land
    // on Operations, where the System Health strip surfaces the same
    // "workers: offline" state this notification describes.
    if (n.type === 'WORKERS_OFFLINE') return '/operations';
    // AI_PROCESSING_SKIPPED always carries documentId, so it's already
    // handled by the generic `if (documentId)` branch above.
    // Engine approval / audit-stage / escalation notifications with no backing
    // document (e.g. FORM items) land on My Work, where the item is actionable.
    if (t.startsWith('APPROVAL') || t.startsWith('AUDIT_STAGE') || t === 'ASSIGNEE_DEACTIVATED') {
      return '/dashboard/mywork';
    }
    return null;
  };

  const openNotification = (n: any) => {
    if (!n.readAt && !n.isRead) markRead.mutate(n.id);
    const href = notificationHref(n);
    if (href) router.push(href);
  };

  return (
    <PermissionGate permission={PERMISSIONS.NOTIFICATION_READ}>
      <>
        <TopBar
          title="Notifications"
          breadcrumbs={[{ label: 'Notifications' }]}
          onMobileMenuToggle={toggleSidebar}
        />
        <div className="flex-1 overflow-y-auto min-h-0 p-6 max-w-3xl mx-auto w-full">
          <PageHeader
            title="Notifications"
            subtitle={
              unread > 0
                ? `${unread} unread notification${unread > 1 ? 's' : ''}`
                : 'All caught up'
            }
            actions={
              unread > 0 ? (
                <button
                  onClick={() => markAllRead.mutate()}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-text-secondary bg-surface-card border border-border rounded-lg hover:bg-surface-raised"
                >
                  <CheckCheck className="h-4 w-4" /> Mark all read
                </button>
              ) : undefined
            }
          />

          {/* Tab bar */}
          <div className="flex gap-1 p-1 bg-surface-raised rounded-xl mb-4 w-fit">
            {(['all', 'unread', 'workflow', 'system'] as NotifTab[]).map((t) => (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all',
                  activeTab === t
                    ? 'bg-surface-card shadow-sm text-text-primary'
                    : 'text-text-muted hover:text-text-secondary',
                )}
              >
                {t === 'unread'
                  ? `Unread (${unread})`
                  : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="ui-skeleton h-16 rounded-xl" />
              ))}
            </div>
          ) : filteredNotifs.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No notifications"
              description="You're all caught up. New notifications will appear here."
            />
          ) : (
            <div className="ui-card space-y-2">
              {paged.map((n: any) => {
                const Icon = TYPE_ICONS[n.type as NotifType] ?? Info;
                const colorClass =
                  TYPE_COLORS[n.type as NotifType] ??
                  'bg-surface-raised text-text-muted';
                const isUnread = !n.readAt;
                return (
                  // A real <button>, not a clickable <div>. The row contains no
                  // nested interactive elements, so the native element is
                  // available here — and it is what gives keyboard users a way
                  // to open a notification at all, which the div never had.
                  // `text-left` and `w-full` restore the block layout a button
                  // would otherwise lose.
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openNotification(n)}
                    className={cn(
                      'w-full text-left flex items-start gap-4 p-4 rounded-xl border transition-all cursor-pointer',
                      isUnread
                        ? 'bg-brand-50 border-brand-100 hover:bg-brand-100 dark:bg-brand-500/15 dark:border-brand-500/30 dark:hover:bg-brand-500/20'
                        : 'bg-surface-card border-border hover:bg-surface-raised',
                    )}
                  >
                    <div className={cn('p-2.5 rounded-xl shrink-0', colorClass)}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className={cn(
                          'text-sm',
                          isUnread
                            ? 'font-semibold text-text-primary'
                            : 'font-medium text-text-secondary',
                        )}
                      >
                        {n.message ?? n.body ?? n.title}
                      </p>
                      <p className="text-xs text-text-muted mt-1">
                        {format(new Date(n.createdAt), 'MMM d, yyyy · HH:mm')}
                      </p>
                    </div>
                    {isUnread && (
                      <div className="h-2 w-2 rounded-full bg-brand-500 mt-1.5 shrink-0" />
                    )}
                  </button>
                );
              })}
              {filteredNotifs.length > PAGE_SIZE && (
                <PaginationControls
                  page={page}
                  onPageChange={setPage}
                  hasPrevious={page > 1}
                  hasNext={page * PAGE_SIZE < filteredNotifs.length}
                  totalPages={totalPages}
                />
              )}
            </div>
          )}
        </div>
      </>
    </PermissionGate>
  );
}
