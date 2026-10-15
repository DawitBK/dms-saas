// Shared "should this named-person pick be warned about" helper, reused by
// the letters submit-chain modal (approver + signatory pickers), the unified
// approvals engine's ApprovalChainCard, and e-signing's recipient picker
// (see PARTITIONED-PERCOLATING-KITTEN plan, 2026-09-02). Never blocks an
// assignment — only tells the UI whether to show an inline amber warning.

import { useQuery } from '@tanstack/react-query';
import { apiClient } from './apiClient';
import { usePermissions } from '../hooks/usePermissions';
import { PERMISSIONS } from './permissions';

export type AclResourceType = 'document' | 'folder' | 'department' | 'workflow' | 'workflow_task' | 'retention' | 'legal_hold';

export type AssignmentAdvisoryResult = { inDepartment: boolean; aclAllowed: boolean };

/** Server round trip for the ACL half of the warning (and a second opinion
 *  on department membership) — only enabled once a named candidate is
 *  actually picked, not for every row while browsing the picker's list. */
export function useAssignmentAdvisory(params: {
  candidateUserId: string | null | undefined;
  departmentId?: string | null;
  resourceType: AclResourceType;
  resourceId: string | null | undefined;
  permission?: string;
}) {
  const { candidateUserId, departmentId, resourceType, resourceId, permission = 'document:read' } = params;
  return useQuery({
    queryKey: ['assignment-advisory', candidateUserId, departmentId, resourceType, resourceId, permission],
    queryFn: async () => {
      const qs = new URLSearchParams({
        candidateUserId: candidateUserId as string,
        resourceType,
        resourceId: resourceId as string,
        permission,
      });
      if (departmentId) qs.set('departmentId', departmentId);
      const res = await apiClient<{ data: AssignmentAdvisoryResult }>(`/assignment-advisory/check?${qs}`);
      return res.data;
    },
    enabled: Boolean(candidateUserId && resourceId),
    staleTime: 30_000,
  });
}

export type AssignableRole = {
  id: string;
  name: string;
  /** Active holders who could actually take a step assigned to this role in
   *  the department that was asked about. Present only when `departmentId`
   *  was supplied. 0 means submitting would be refused with
   *  ERR-STEP-ROLE-UNSTAFFED, so the picker can say so up front. */
  holderCount?: number;
  /** Whether that count was department-scoped at all — a role granting the
   *  domain's read-all permission is counted tenant-wide, matching the
   *  cross-department escape hatch the decide path grants. */
  departmentScoped?: boolean;
};

/** Role names an assignment picker may offer, optionally narrowed to roles
 *  that actually resolve (in THIS tenant, custom role_permissions included) to
 *  `permission` — so the dropdown can't offer a role the backend will then
 *  refuse (`ERR-STEP-ROLE-INVALID`), and a runtime-created custom role becomes
 *  assignable instead of being invisible to every picker.
 *
 *  Reachable by any letter drafter / approval submitter / signing manager,
 *  unlike GET /roles (role:read | acl:manage). `fallback` keeps the picker
 *  usable if the request ever fails. */
export function useAssignableRoles(
  permission?: string,
  fallback: string[] = [],
  /** The item's department. Supplying it makes the response say which of those
   *  roles actually has someone able to act HERE, so a picker can flag the
   *  unstaffed ones instead of letting submit fail after the fact. */
  departmentId?: string | null,
) {
  // GET /assignment-advisory/roles answers 403 to anyone who cannot build a chain, a letter or a signing request, so a
  // screen that merely MENTIONS a role picker must not fire it for them (the picker then shows the fallback names).
  const { canAny } = usePermissions();
  const mayPick = canAny([PERMISSIONS.LETTER_CREATE, PERMISSIONS.APPROVAL_SUBMIT, PERMISSIONS.SIGNING_MANAGE]);
  const query = useQuery({
    enabled: mayPick,
    queryKey: ['assignable-roles', permission ?? 'all', departmentId ?? 'no-dept'],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (permission) qs.set('permission', permission);
      if (departmentId) qs.set('departmentId', departmentId);
      const suffix = qs.toString() ? `?${qs}` : '';
      const res = await apiClient<{ data: AssignableRole[] }>(`/assignment-advisory/roles${suffix}`);
      return res.data;
    },
    staleTime: 5 * 60_000,
  });
  const roles = query.data ?? [];
  const names = roles.map((r) => r.name);
  /** Roles the backend would refuse as unstaffed. Empty when the caller asked
   *  without a department, or while the request is still in flight — callers
   *  must treat "not known to be unstaffed" as allowed, never block on it. */
  const unstaffed = new Set(
    roles.filter((r) => r.holderCount === 0).map((r) => r.name),
  );
  return {
    ...query,
    roles,
    unstaffed,
    names: names.length > 0 ? names : fallback,
  };
}

/** Client-side half of the warning — no round trip needed, since every
 *  assignable-users endpoint already returns each candidate's departments.
 *  A candidate with no department memberships at all still counts as
 *  "outside" (they're not IN the target department either). */
export function isOutsideDepartment(
  candidateDepartments: Array<{ id: string }> | undefined,
  targetDepartmentId: string | null | undefined,
): boolean {
  if (!targetDepartmentId) return false;
  return !(candidateDepartments ?? []).some((d) => d.id === targetDepartmentId);
}
