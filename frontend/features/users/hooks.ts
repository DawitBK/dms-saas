import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../shared/lib/apiClient';

export type UserRole = { id: string; name: string };
export type UserDepartment = { id: string; name: string; code: string; orgUnitId?: string | null };

export type UserRecord = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  isMfaEnabled?: boolean;
  lastLoginAt?: string | null;
  lockedUntil?: string | null;
  createdAt?: string;
  roles?: UserRole[];
  departments?: UserDepartment[];
  role?: string | null;
};

export type RoleRecord = { id: string; name: string; description?: string };

export type AuditEntry = {
  id: string;
  eventType: string;
  timestamp: string;
  actionDetails?: Record<string, unknown>;
};

export type AclGrant = {
  id: string;
  resourceType: string;
  resourceId: string;
  principalType: string;
  principalId: string;
  permission: string;
  effect: 'ALLOW' | 'DENY';
  expiresAt?: string | null;
  grantedById?: string | null;
  createdAt?: string;
};

const USERS_KEY = ['admin-users'] as const;

export type UsersListParams = {
  skip?: number;
  take?: number;
  q?: string;
  roleId?: string;
  departmentId?: string;
  orgUnitId?: string;
  isActive?: 'active' | 'inactive';
};

// Paginated, 15/page by default (matches GET /documents' skip/take convention —
// see documents.routes.ts). Search/role/department/org-unit/status filters are
// sent as query params so they're applied server-side and compose with
// pagination, instead of only filtering whatever page happens to already be
// loaded. orgUnitId is resolved server-side to "any department under this org
// unit" (users.service.ts's listUsers) rather than client-side, since this
// list is paginated -- filtering only the current page client-side would
// desync the page count and total from what's actually being shown.
//
// FIX: this is the ONLY consumer of GET /users that goes through this hook
// (AccessControlCenter/ApprovalChainsPanel/letters assignee pickers/etc. all
// call the endpoint directly with their own ad-hoc query because they
// legitimately need to name any user in the tenant) — so `scope=mine` is
// safe to send unconditionally here without affecting those other pickers.
// A DEPT_MANAGER holds USER_MANAGE (not an admin-only permission) but
// should only see/manage their own department's staff on the Users admin
// table by default; ACL_BYPASS_ADMIN holders still get the unfiltered list
// (the backend ignores the param for them).
export function useUsersList(params: UsersListParams = {}) {
  const { skip = 0, take = 15, q, roleId, departmentId, orgUnitId, isActive } = params;
  return useQuery({
    queryKey: [...USERS_KEY, 'mine', { skip, take, q, roleId, departmentId, orgUnitId, isActive }],
    queryFn: async () => {
      const qs = new URLSearchParams({ skip: String(skip), take: String(take), scope: 'mine' });
      if (q) qs.set('q', q);
      if (roleId) qs.set('roleId', roleId);
      if (departmentId) qs.set('departmentId', departmentId);
      if (orgUnitId) qs.set('orgUnitId', orgUnitId);
      if (isActive) qs.set('isActive', isActive);
      const res = await apiClient<{ data: UserRecord[]; total: number }>(`/users?${qs}`);
      return { data: res.data ?? [], total: res.total ?? (res.data ?? []).length };
    },
    staleTime: 30_000,
  });
}

export function useRolesList() {
  return useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      const res = await apiClient<{ data: RoleRecord[] }>('/roles');
      return res.data ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

export function useUserDetail(id: string | null) {
  return useQuery({
    queryKey: ['user-detail', id],
    queryFn: async () => {
      const res = await apiClient<UserRecord>(`/users/${id}`);
      return res;
    },
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useUserActivity(id: string | null) {
  return useQuery({
    queryKey: ['user-activity', id],
    queryFn: async () => {
      const res = await apiClient<{ data: AuditEntry[] }>(`/users/${id}/activity`);
      return res.data ?? [];
    },
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useUserAclGrants(userId: string | null) {
  return useQuery({
    queryKey: ['user-acl-grants', userId],
    queryFn: async () => {
      const res = await apiClient<{ data: AclGrant[] }>(
        `/acl?principalType=user&principalId=${userId}`
      );
      return res.data ?? [];
    },
    enabled: !!userId,
    staleTime: 10_000,
  });
}

export function useRolePermissions(roleId: string | null) {
  return useQuery({
    queryKey: ['role-permissions', roleId],
    queryFn: async () => {
      const res = await apiClient<{ data: { roleId: string; permissions: string[] } }>(
        `/roles/${roleId}/permissions`
      );
      return res.data?.permissions ?? [];
    },
    enabled: !!roleId,
    staleTime: 5 * 60_000,
  });
}

export function useFoldersList() {
  return useQuery({
    queryKey: ['folders-list'],
    queryFn: async () => {
      const res = await apiClient<{ data: Array<{ id: string; name: string; path: string }> }>('/folders');
      return res.data ?? [];
    },
    staleTime: 5 * 60_000,
  });
}

export function useUserMutations() {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: USERS_KEY });
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['user-detail'] });
  };

  const invalidateGrants = (userId: string) => {
    qc.invalidateQueries({ queryKey: ['user-acl-grants', userId] });
  };

  const createUser = useMutation({
    mutationFn: (body: {
      email: string;
      firstName: string;
      lastName: string;
      isActive?: boolean;
      roleIds: string[];
      departmentIds?: string[];
    }) => apiClient('/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });

  const updateUser = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<{
        email: string;
        firstName: string;
        lastName: string;
        isActive: boolean;
      }>;
    }) => apiClient(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: invalidate,
  });

  const assignRole = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      apiClient(`/users/${userId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleId }),
      }),
    onSuccess: invalidate,
  });

  const removeRole = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      apiClient(`/users/${userId}/roles/${roleId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const assignDepartment = useMutation({
    mutationFn: ({
      userId,
      departmentId,
    }: {
      userId: string;
      departmentId: string;
    }) =>
      apiClient(`/users/${userId}/departments`, {
        method: 'POST',
        body: JSON.stringify({ departmentId }),
      }),
    onSuccess: invalidate,
  });

  const removeDepartment = useMutation({
    mutationFn: ({
      userId,
      departmentId,
    }: {
      userId: string;
      departmentId: string;
    }) =>
      apiClient(`/users/${userId}/departments/${departmentId}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });

  const activateUser = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/users/${id}/activate`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const deactivateUser = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/users/${id}/deactivate`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const forceLogout = useMutation({
    mutationFn: (id: string) =>
      apiClient(`/users/${id}/force-logout`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const softDeleteUser = useMutation({
    mutationFn: (id: string) => apiClient(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const grantAccess = useMutation({
    mutationFn: ({
      resourceType,
      resourceId,
      principalId,
      permission,
      effect,
      expiresAt,
    }: {
      resourceType: string;
      resourceId: string;
      principalId: string;
      permission: string;
      effect: 'ALLOW' | 'DENY';
      expiresAt?: string;
    }) =>
      apiClient(`/acl/${resourceType}/${resourceId}`, {
        method: 'POST',
        body: JSON.stringify({
          principalType: 'user',
          principalId,
          permission,
          effect,
          expiresAt: expiresAt || undefined,
        }),
      }),
    onSuccess: (_data, vars) => invalidateGrants(vars.principalId),
  });

  const revokeAccess = useMutation({
    mutationFn: ({ aclId, userId }: { aclId: string; userId: string }) =>
      apiClient(`/acl/${aclId}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) => invalidateGrants(vars.userId),
  });

  return {
    createUser,
    updateUser,
    assignRole,
    removeRole,
    assignDepartment,
    removeDepartment,
    activateUser,
    deactivateUser,
    forceLogout,
    softDeleteUser,
    grantAccess,
    revokeAccess,
  };
}
