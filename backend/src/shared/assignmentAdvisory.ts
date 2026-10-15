// Shared building blocks for "assign an approver/signer by role or by named
// person" pickers across letters, the unified approvals engine, and e-signing
// (see PARTITIONED-PERCOLATING-KITTEN plan, 2026-09-02).
//
// Named-person assignment is intentionally global-scoped everywhere it
// already exists (a named assignee can act on an item outside their own
// department — see letters.service.ts's assertStepIsActionable/decideStep
// comments) — this module doesn't change that. It only gives every picker a
// non-blocking, read-only way to warn the person doing the assigning when
// their pick is cross-department or lacks ACL, without ever refusing the
// assignment itself.

import { notPlatformAdminSql } from './platformAdmin.js';
import { QueryTypes } from 'sequelize';
import { sequelize, UserDepartment } from '../infrastructure/database/index.js';
import { resolveACL, type AclResourceType } from './resolveACL.js';

/** IDs of active users holding `roleName` in `tenantId` (optionally narrowed
 *  to members of `departmentId`, matching the department-scoping rule
 *  role-assigned approval steps are already subject to in decideStep).
 *
 *  Relocated verbatim from letters.service.ts (previously private there,
 *  used only by notifyStepPending) so e-signing's role-based recipient claim
 *  and letters' new role-based signatory option can reuse the same query
 *  instead of duplicating it. This is deliberately simpler than
 *  letters.service.ts's own assertStepIsActionable, which additionally joins
 *  to check the role holds a specific LETTER permission — that's a
 *  letters-approval-specific rule and stays exactly as it was. */
export async function resolveRoleUserIds(
  roleName: string,
  tenantId: string,
  departmentId: string | null,
): Promise<string[]> {
  const rows = await sequelize.query<{ id: string }>(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = :tenantId
       ${departmentId ? 'JOIN user_departments ud ON ud.user_id = u.id AND ud.department_id = :departmentId' : ''}
      WHERE r.name = :roleName AND u.is_active = true AND ${notPlatformAdminSql('u.id')}`,
    { replacements: { roleName, tenantId, departmentId }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.id);
}

export interface AssignmentAdvisoryInput {
  candidateUserId: string;
  tenantId: string;
  /** The item's own department, if any. `null`/`undefined` means there's
   *  nothing to compare against, so `inDepartment` is reported `true` (no
   *  warning), same as every existing "no department on this item" bypass
   *  elsewhere in the codebase. */
  departmentId?: string | null;
  resourceType: AclResourceType;
  resourceId: string;
  permission: string;
}

export interface AssignmentAdvisoryResult {
  inDepartment: boolean;
  aclAllowed: boolean;
}

/** Non-blocking "should the person assigning this named candidate be warned"
 *  check — never throws, never denies the assignment itself. Used by the new
 *  GET /assignment-advisory/check route, and safe to call directly from
 *  backend code that already has a candidate/resource pair in hand.
 *
 *  Resolves the CANDIDATE's own roles internally (not the caller's — the ACL
 *  question is "can the person being assigned reach this resource", not "can
 *  the person doing the assigning reach it") via the same roles/user_roles
 *  join used throughout letters.service.ts's own validation. */
export async function checkAssignmentAdvisory(
  input: AssignmentAdvisoryInput,
): Promise<AssignmentAdvisoryResult> {
  const inDepartment = input.departmentId
    ? Boolean(
        await UserDepartment.findOne({
          where: { userId: input.candidateUserId, departmentId: input.departmentId },
          attributes: ['id'],
        }),
      )
    : true;

  const candidateRoleRows = await sequelize.query<{ name: string }>(
    `SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = :userId`,
    { replacements: { userId: input.candidateUserId }, type: QueryTypes.SELECT },
  );

  const acl = await resolveACL({
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    permission: input.permission,
    userId: input.candidateUserId,
    userRoles: candidateRoleRows.map((r) => r.name),
    tenantId: input.tenantId,
  });

  return { inDepartment, aclAllowed: acl.allowed };
}
