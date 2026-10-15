// SPRINT-4/5: document hooks will need to respect ACL-scoped queries and refreshed search/lifecycle semantics.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../state/auth.store';
import { apiClient } from '../../shared/lib/apiClient';
import {
  listDocuments,
  createDocument,
  getDocument,
  listWorkflowTasks,
  getWorkflowInstanceTasks,
  submitTaskDecision,
  listAuditLogs,
  fetchDashboardStats,
} from './api';
import type { CreateDocumentInput, DocumentDetail } from './types';

export function useDocuments() {
  const { userId, role } = useAuthStore();
  const scopeKey = `${userId}:${role}`;
  return useQuery({
    queryKey: ['documents', scopeKey],
    queryFn: async () => {
      const res = await listDocuments(0, 50);
      return res.data;
    },
    enabled: Boolean(userId && role),
    staleTime: 30_000, // 30 seconds
  });
}

export function useDashboardStats() {
  const { userId, role } = useAuthStore();
  return useQuery({
    queryKey: ['dashboard-stats', userId, role],
    queryFn: () => fetchDashboardStats(),
    enabled: Boolean(userId && role),
    staleTime: 60_000, // 60 seconds
    // The dashboard is a cross-surface summary. Recheck it on navigation so
    // a newly filed upload or compiled bundle is reflected immediately.
    refetchOnMount: 'always',
  });
}

export function useWorkflowTasks() {
  const { userId, role } = useAuthStore();
  return useQuery({
    queryKey: ['workflow-tasks', userId, role],
    queryFn: () => listWorkflowTasks().then((res) => res.data),
    enabled: Boolean(userId && role),
    staleTime: 15_000, // 15 seconds — workflow tasks change frequently
  });
}

// Paginated workflow-task query returning the full {data,total,page,limit}
// envelope. Backend GET /workflow/tasks filters by a single status (default
// PENDING). The queue panel drives two independent instances of this — one for
// PENDING, one for COMPLETED — so the "Recently Completed" section actually
// populates (the endpoint's PENDING default previously meant completed tasks
// were never fetched at all) and both sections page independently.
export function useWorkflowTasksPage(params: { page: number; limit: number; status: string }) {
  const { userId, role } = useAuthStore();
  return useQuery({
    queryKey: ['workflow-tasks-page', userId, role, params.status, params.page, params.limit],
    queryFn: () => listWorkflowTasks(params),
    enabled: Boolean(userId && role),
    staleTime: 15_000,
  });
}

export function useWorkflowInstanceTasks(instanceId: string | undefined) {
  return useQuery({
    queryKey: ['workflow-instance-tasks', instanceId],
    queryFn: () => getWorkflowInstanceTasks(instanceId!).then((res) => res.data),
    enabled: Boolean(instanceId),
    staleTime: 15_000,
  });
}

export function useSubmitTaskDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      decision,
      reason,
    }: {
      taskId: string;
      decision: 'APPROVE' | 'REJECT';
      reason?: string;
    }) => submitTaskDecision(taskId, decision, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-tasks'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Decision failed'),
  });
}

export function useAuditLogs(params?: {
  documentId?: string;
  eventType?: string;
}) {
  return useQuery({
    queryKey: ['audit-logs', params],
    queryFn: () => listAuditLogs(params).then((res: any) => res.data),
    staleTime: 5_000, // 5 s — audit logs are append-only so brief caching is safe
    refetchOnMount: true,
  });
}

// Paginated variant for the Audit Logs table (Operations → Audit Logs panel),
// 15/page — see documents.routes.ts's skip/take convention. Kept separate
// from useAuditLogs() above (which several other consumers — the dashboard
// widget, the document-detail history tab, the integrity-check panel's count
// — still call unpaginated) so this doesn't change what those get back.
export function useAuditLogsPage(params: {
  eventType?: string;
  q?: string;
  skip: number;
  take: number;
}) {
  return useQuery({
    queryKey: ['audit-logs-page', params],
    queryFn: () => listAuditLogs(params),
    staleTime: 5_000,
    refetchOnMount: true,
  });
}

export function useDocument(id: string) {
  const { userId, role } = useAuthStore();
  const scopeKey = `${userId}:${role}`;
  return useQuery({
    queryKey: ['document', id, scopeKey],
    queryFn: () => getDocument(id),
    enabled: Boolean(userId && role && id),
    staleTime: 30_000, // 30 seconds
  });
}

export function useCreateDocument() {
  const queryClient = useQueryClient();
  const { userId, role } = useAuthStore();
  const scopeKey = `${userId}:${role}`;

  return useMutation({
    mutationFn: ({ input, file }: { input: CreateDocumentInput; file: File }) =>
      createDocument(input, file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['documents-list'] });
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      queryClient.invalidateQueries({ queryKey: ['folders-list'] });
      queryClient.invalidateQueries({ queryKey: ['folder-contents'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      queryClient.invalidateQueries({ queryKey: ['my-work'] });
      queryClient.invalidateQueries({ queryKey: ['my-work-count'] });
    },
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient(`/notifications/${id}/read`, { method: 'PATCH' }),
    onMutate: async () => {
      // Optimistically decrement the badge count
      await queryClient.cancelQueries({ queryKey: ['notifications-count'] });
      const prev = queryClient.getQueryData<{ count: number }>(['notifications-count']);
      if (prev) {
        queryClient.setQueryData(['notifications-count'], {
          count: Math.max(0, prev.count - 1),
        });
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['notifications-count'], ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient('/notifications/read-all', { method: 'PATCH' }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['notifications-count'] });
      queryClient.setQueryData(['notifications-count'], { count: 0 });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

// §1 FIX: Re-export shared lookup hooks from the canonical location.
// This ensures a single query key + return shape across the entire app.
export { useDepartments, useDocumentTypes } from '../../shared/hooks/useLookups';
