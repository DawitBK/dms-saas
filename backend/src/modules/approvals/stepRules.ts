// The ONE implementation of the approval-step assignment and decision rules.
//
// Documentations/audits/AUDIT-FINDINGS-2026-09-03.md R-08 ("two approval engines coexist"): letters
// (`letters.service.ts`) and the unified engine (`approvals.service.ts`) each
// carried their own copy of these rules. The engine's copy was even labelled
// "Mirror of letters' assertStepIsActionable" — and the two had already
// drifted in three ways by the time they were compared:
//
//  1. WHICH PERMISSION a decider must hold: letter:approve / letter:review
//     per step type, versus a flat approval:decide. This is a genuine
//     difference between the two permission domains, not drift, so it stays
//     parameterised — see StepRuleProfile.
//
//  2. THE CROSS-DEPARTMENT ESCAPE HATCH — a real defect. Both decide paths
//     let a holder of their domain's read-all permission (letter:read_all,
//     document:read_all) decide a role-assigned step on an item outside
//     their own department. Only letters' submit-time validator knew that.
//     The engine's validator required at least one qualified role holder to
//     be a member of the item's department, full stop — so a role whose
//     qualified holders all sit outside it (a central-archive or EXECUTIVE
//     role holding document:read_all) was rejected at submit time with
//     ERR-STEP-ROLE-UNSTAFFED even though decideStep would happily have let
//     those same people decide. Exactly the class of submit-vs-decide
//     disagreement the 2026-09-03 coherence pass fixed for permission
//     resolution, missed here because the rule existed twice. Unifying
//     applies the hatch on both sides of both domains.
//
//  3. UNCAT NORMALIZATION: the engine treats the tenant's synthetic UNCAT
//     filing bucket as "no department" (nobody is ever a member of it, so a
//     department-scoped role check against it can never be satisfied);
//     letters never did. Not reachable for letters today — letter creation
//     requires a real departmentId and asserts the drafter's membership in
//     it — but the asymmetry is the kind that becomes a live bug the moment
//     letters gain any filing path that skips department selection.
//     Normalization now happens INSIDE these helpers, so neither caller can
//     forget it.
//
// Keeping the rules here means a change to "who can be assigned work" is a
// one-file change that both domains inherit, instead of two edits that have
// to be kept in agreement by hand.

import { assertNotHiddenUser, notPlatformAdminSql } from "../../shared/platformAdmin.js";
import { QueryTypes, type Transaction as SequelizeTransaction } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS, type Permission } from "../../config/permissions.js";
import {
  Department,
  sequelize,
  User,
  UserTenant,
} from "../../infrastructure/database/index.js";
import {
  cacheUserDepartments,
  getCachedUserDepartments,
  loadUserDepartmentIds,
} from "../../infrastructure/cache/userDeptCache.js";
import { getResolvedRolePermissions } from "../roles/roles.service.js";

/** The authenticated caller, as every approval path needs it. Was defined
 *  identically (byte for byte) in both approvals.service.ts and
 *  letters.service.ts; both now re-export this one. */
export type CurrentUser = {
  userId: string;
  role: string;
  roles?: string[];
  tenantId: string;
  permissions?: string[];
};

export type StepType = "APPROVE" | "REVIEW";

/** A step's assignment, as supplied at submit time or stored on a row. */
export type StepAssignment = {
  stepType?: StepType;
  assignedUserId?: string | null;
  assignedRole?: string | null;
};

/**
 * What differs legitimately between the letter domain and the generic
 * document/form engine. Everything else about the rules is shared.
 */
export type StepRuleProfile = {
  /** Permission a decider of this step must hold. */
  decidePermission: (stepType: StepType) => Permission;
  /**
   * Holding this lifts department scoping for role-assigned steps, matching
   * the escape hatch the domain's own decide path grants. Checked against the
   * ASSIGNED ROLE's resolved permissions at submit time (if the role grants
   * cross-department read, its holders are not department-scoped) and against
   * the ACTOR's permissions at decide time.
   */
  crossDepartmentPermission: Permission;
  /** Noun used in error copy, so messages read naturally in each domain. */
  itemNoun: string;
};

export const LETTER_STEP_RULES: StepRuleProfile = {
  decidePermission: (stepType) =>
    stepType === "APPROVE" ? PERMISSIONS.LETTER_APPROVE : PERMISSIONS.LETTER_REVIEW,
  crossDepartmentPermission: PERMISSIONS.LETTER_READ_ALL,
  itemNoun: "letter",
};

export const ENGINE_STEP_RULES: StepRuleProfile = {
  // The generic engine gates every step type on one permission; there is no
  // separate "review" permission in the approval:* family.
  decidePermission: () => PERMISSIONS.APPROVAL_DECIDE,
  crossDepartmentPermission: PERMISSIONS.DOCUMENT_READ_ALL,
  itemNoun: "item",
};

export function hasPermission(user: CurrentUser, permission: string): boolean {
  return (user.permissions ?? []).includes(permission);
}

/** Is this step addressed to this user — by name, or through a role they hold? */
export function stepIsAssignedTo(
  step: { assignedUserId?: string | null; assignedRole?: string | null },
  user: CurrentUser,
): boolean {
  if (step.assignedUserId) return step.assignedUserId === user.userId;
  if (step.assignedRole) return (user.roles ?? [user.role]).includes(step.assignedRole);
  return false;
}

/**
 * The user's department memberships.
 *
 * Was implemented four times — letters.service.ts, documents.service.ts,
 * shared/resolveACL.ts (documents' copy even carried a comment noting it
 * duplicated letters') and inline in approvals.service.ts. Three of the four
 * read through the 300 s userDeptCache; the engine's inline
 * `UserDepartment.findAll` was the only one that did not, so the engine's
 * decide path hit Postgres on every decision while the far more
 * security-sensitive ACL path was happy to trust the cache. Unified on the
 * cached form: invalidation is already wired to every UserDepartment
 * mutation (users.service.ts calls invalidateUserDepartments on assign,
 * unassign and replace).
 */
export async function getUserDepartmentIds(tenantId: string, userId: string): Promise<string[]> {
  const cached = await getCachedUserDepartments(tenantId, userId);
  if (cached) return cached;
  const departmentIds = await loadUserDepartmentIds(tenantId, userId);
  await cacheUserDepartments(tenantId, userId, departmentIds);
  return departmentIds;
}

/**
 * The tenant's "UNCAT" department (tenants.service.ts's createTenant(), the
 * fallback bucket for e-signing uploads that skip department selection) is a
 * synthetic filing bucket, not a real org unit anyone is ever a member of.
 * Department-scoped role checks resolve "who can act" through
 * user_departments membership in the item's department — for UNCAT that
 * membership can never exist, so every role-assigned step on an
 * uncategorized document was permanently unstaffed (ERR-STEP-ROLE-UNSTAFFED)
 * and even a role holder who *was* assigned the step couldn't decide it
 * (ERR-STEP-DEPT-SCOPE). Treating UNCAT as "no department" for approval
 * purposes routes those checks to the tenant-wide fallback instead.
 */
export async function normalizeApprovalDepartmentId(
  tenantId: string,
  departmentId: string | null,
  tx?: SequelizeTransaction,
): Promise<string | null> {
  if (!departmentId) return null;
  const dept = await Department.findOne({
    where: { id: departmentId, tenantId, code: "UNCAT" },
    transaction: tx,
  });
  return dept ? null : departmentId;
}

export async function assertAssigneeInTenant(userId: string, tenantId: string): Promise<void> {
  // The hidden platform administrator can never be named as an approver, reviewer, delegate or auditor:
  // a request that names it answers exactly like an unknown id (shared/platformAdmin.ts, letters L11).
  await assertNotHiddenUser(userId);
  const membership = await UserTenant.findOne({ where: { userId, tenantId } });
  if (!membership)
    throw new AppError(422, "ERR-ASSIGNEE-INVALID", "Assigned user is not a member of this tenant");
}

/**
 * No chain may be created that nobody can decide.
 *
 * A cross-tenant, inactive, or under-permissioned named assignee — or a role
 * with nobody qualified to act on it — leaves the step permanently PENDING
 * with no reassignment path once the item is in review. So validate at submit
 * time that SOMEONE can actually decide each step, mirroring exactly the
 * conditions the decide path checks (see assertRoleStepDepartmentScope).
 *
 * Named users must be active members of the tenant holding the step's decide
 * permission; roles must grant it AND have at least one active holder, scoped
 * to the item's department unless the role grants cross-department read.
 *
 * Role permissions are resolved PER TENANT (`role_permissions`, with the
 * static ROLE_PERMISSIONS map as fallback) rather than from the static map
 * alone, so this validator agrees with the decide path — which authorizes off
 * the caller's own tenant-resolved permission set. A tenant that granted the
 * decide permission to a custom role previously had holders who could decide
 * but could not be assigned. getResolvedRolePermissions is Redis/LRU-cached.
 */
export async function assertStepIsActionable(
  step: StepAssignment,
  tenantId: string,
  departmentId: string | null,
  profile: StepRuleProfile,
  tx?: SequelizeTransaction,
): Promise<void> {
  const needed = profile.decidePermission(step.stepType ?? "APPROVE");

  if (step.assignedUserId) {
    await assertAssigneeInTenant(step.assignedUserId, tenantId);
    const assignee = await User.findOne({ where: { id: step.assignedUserId, isActive: true } });
    if (!assignee) throw new AppError(422, "ERR-ASSIGNEE-INVALID", "Assigned user is not active");
    const roleRows = await sequelize.query<{ name: string }>(
      `SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = :userId`,
      { replacements: { userId: step.assignedUserId }, type: QueryTypes.SELECT },
    );
    const assigneeRolePerms = await Promise.all(
      roleRows.map((r) => getResolvedRolePermissions(r.name, tenantId)),
    );
    const canAct = assigneeRolePerms.some((perms) => (perms as readonly string[]).includes(needed));
    if (!canAct)
      throw new AppError(422, "ERR-ASSIGNEE-INVALID", `Assigned user does not hold ${needed}`);
    return;
  }

  if (step.assignedRole) {
    const eligibility = await resolveRoleStepEligibility(
      step.assignedRole,
      needed,
      profile.crossDepartmentPermission,
      tenantId,
      departmentId,
      tx,
    );
    if (!eligibility.grantsPermission)
      throw new AppError(
        422,
        "ERR-STEP-ROLE-INVALID",
        `Role ${step.assignedRole} does not hold ${needed}`,
      );
    if (eligibility.holderCount === 0)
      throw new AppError(
        422,
        "ERR-STEP-ROLE-UNSTAFFED",
        eligibility.departmentScoped
          ? `No active user holding role ${step.assignedRole} is a member of this ${profile.itemNoun}'s department`
          : `No active user holds role ${step.assignedRole} in this tenant`,
      );
    return;
  }

  throw new AppError(422, "ERR-STEP-UNASSIGNED", "Each approval step must have an assigned user or role");
}

/**
 * "Could a role-assigned step to this role actually be decided by somebody?"
 * — the exact question assertStepIsActionable asks above, extracted so it can
 * also be ANSWERED IN ADVANCE.
 *
 * Why it is shared rather than reimplemented: the submit-chain picker used to
 * offer every role name unconditionally, so choosing one whose holders all sit
 * outside the item's department produced ERR-STEP-ROLE-UNSTAFFED only after
 * the user pressed Submit. GET /assignment-advisory/roles already existed to
 * stop the same picker offering a role the backend would refuse with
 * ERR-STEP-ROLE-INVALID — the sibling error thrown a few lines above — but it
 * could not answer the staffing half, because the staffing rule lived inline
 * in the validator. A second copy in the endpoint would be exactly the
 * submit-vs-decide drift this file's header exists to prevent, so there is one
 * copy and both callers use it.
 *
 * The two halves are reported separately, never collapsed into one boolean:
 * "this role cannot decide this step type" and "this role has nobody in this
 * department" are different problems with different fixes (change the step,
 * versus staff the department), and the UI says which.
 *
 * `departmentScoped` is the cross-department escape hatch, and it is why the
 * count cannot be computed from the role alone: a role granting the domain's
 * read-all permission is NOT department-scoped, so its holders qualify
 * tenant-wide. UNCAT normalization happens here too, per this file's rule that
 * callers cannot forget it.
 */
export type RoleStepEligibility = {
  /** Does the role resolve (in this tenant) to the step's decide permission? */
  grantsPermission: boolean;
  /** Were holders required to be members of the item's department? */
  departmentScoped: boolean;
  /** Active tenant members holding the role who qualify under that scoping. */
  holderCount: number;
};

export async function resolveRoleStepEligibility(
  roleName: string,
  neededPermission: Permission,
  crossDepartmentPermission: Permission,
  tenantId: string,
  departmentId: string | null,
  tx?: SequelizeTransaction,
): Promise<RoleStepEligibility> {
  const scopeDeptId = await normalizeApprovalDepartmentId(tenantId, departmentId, tx);
  const rolePerms = (await getResolvedRolePermissions(roleName, tenantId)) as readonly string[];
  const grantsPermission = rolePerms.includes(neededPermission);

  const departmentScoped = Boolean(scopeDeptId) && !rolePerms.includes(crossDepartmentPermission);
  const rows = await sequelize.query<{ user_id: string }>(
    `SELECT DISTINCT ur.user_id
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id
       INNER JOIN users u ON u.id = ur.user_id AND u.is_active = true
       INNER JOIN user_tenants ut ON ut.user_id = ur.user_id AND ut.tenant_id = :tenantId
       ${departmentScoped ? "INNER JOIN user_departments ud ON ud.user_id = ur.user_id AND ud.department_id = :departmentId" : ""}
      WHERE r.name = :roleName AND ${notPlatformAdminSql("ur.user_id")}`,
    {
      replacements: { tenantId, roleName, departmentId: scopeDeptId },
      type: QueryTypes.SELECT,
    },
  );

  return { grantsPermission, departmentScoped, holderCount: rows.length };
}

/**
 * The decide-time half of the same rule: a role-assigned step on a
 * department-scoped item may only be decided by a member of that department,
 * unless the actor reads across departments. A DEPT_MANAGER in Finance must
 * not approve HR's work just because the role name matches.
 *
 * Named-assignee steps are exempt — naming a person IS the authorization, and
 * cross-department named assignees are the whole point of the picker.
 */
export async function assertRoleStepDepartmentScope(
  step: { assignedUserId?: string | null; assignedRole?: string | null },
  user: CurrentUser,
  tenantId: string,
  departmentId: string | null,
  profile: StepRuleProfile,
): Promise<void> {
  if (!step.assignedRole || step.assignedUserId) return;
  if (hasPermission(user, profile.crossDepartmentPermission)) return;
  const scopeDeptId = await normalizeApprovalDepartmentId(tenantId, departmentId);
  if (!scopeDeptId) return;
  const deptIds = await getUserDepartmentIds(tenantId, user.userId);
  if (!deptIds.includes(scopeDeptId))
    throw new AppError(
      403,
      "ERR-STEP-DEPT-SCOPE",
      `This ${profile.itemNoun} belongs to a department you are not a member of`,
    );
}
