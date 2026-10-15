/**
 * Organisation scope: WHICH departments and users an actor may administer.
 *
 * Permissions answer "may this person administer departments / users at all"
 * (department:manage, user:manage). They say nothing about WHERE. Before this
 * module every holder of department:manage or user:manage — including the
 * default DEPT_MANAGER — could create, rename, move or deactivate ANY
 * department of the tenant, and edit, deactivate, delete, force-log-out,
 * re-role or re-permission ANY user of the tenant (including the tenant's
 * SYSTEM_ADMIN). This module is the single definition of the boundary:
 *
 *   - A department head (a holder of the permission who is a MEMBER of a
 *     department) administers that department and every sub-department below
 *     it. Nothing above it, nothing beside it.
 *   - Tenant-wide structural authority (acl:bypass_admin, i.e. SYSTEM_ADMIN /
 *     PLATFORM_ADMIN, or orgunit:manage) administers the whole tenant and is
 *     the only authority that can create a top-level department.
 *   - Nobody manages a user who holds a permission they lack themselves
 *     ("you cannot touch what outranks you"), the same principle as the
 *     C1 grant guard, applied to the target instead of the grant.
 *
 * It is enforced at the route layer for the DMS UI/API. The SSO internal API
 * (roles/internal.routes.ts) authenticates as a trusted service principal and
 * does not go through it, by design.
 */
import { QueryTypes } from "sequelize";
import { AppError } from "../core/AppError.js";
import { PERMISSIONS } from "../config/permissions.js";
import { Department, UserTenant, sequelize } from "../infrastructure/database/index.js";
import { resolveUnionPermissions } from "../modules/roles/roles.service.js";
import { userNotFound } from "./platformAdmin.js";

export type ScopeActor = {
  userId: string;
  tenantId: string;
  role?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
};

/** Tenant-wide structural authority: may administer every department and every
 *  (outranked-by-actor) user of the tenant, and create top-level departments. */
export function hasTenantWideStructureAuthority(actor: Pick<ScopeActor, "permissions">): boolean {
  const perms = actor.permissions ?? [];
  return perms.includes(PERMISSIONS.ACL_BYPASS_ADMIN) || perms.includes(PERMISSIONS.ORG_UNIT_MANAGE);
}

/**
 * The departments an actor heads: every department they are a member of plus
 * all of their descendants. Tenant-bound on both the membership and the walk.
 * UNION (not UNION ALL) so a corrupt parent cycle cannot loop forever.
 */
export async function getManagedDepartmentIds(tenantId: string, userId: string): Promise<Set<string>> {
  const rows = await sequelize.query<{ id: string }>(
    `WITH RECURSIVE managed AS (
       SELECT d.id FROM departments d
         JOIN user_departments ud ON ud.department_id = d.id
        WHERE ud.user_id = :userId AND d.tenant_id = :tenantId
       UNION
       SELECT c.id FROM departments c
         JOIN managed m ON c.parent_id = m.id
        WHERE c.tenant_id = :tenantId
     ) SELECT id FROM managed`,
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  return new Set(rows.map((r) => r.id));
}

function scopeDenied(message: string, code = "ERR-DEPT-SCOPE"): AppError {
  return new AppError(403, code, message);
}

/** The actor may administer THIS department (it is in their subtree) or has tenant-wide authority. */
export async function assertCanManageDepartment(actor: ScopeActor, departmentId: string): Promise<void> {
  if (hasTenantWideStructureAuthority(actor)) return;
  const managed = await getManagedDepartmentIds(actor.tenantId, actor.userId);
  if (!managed.has(departmentId)) {
    throw scopeDenied("This department is outside the departments you manage");
  }
}

/** Creating a top-level department (no parent) changes the tenant's structure, not a department's. */
export function assertTenantWideStructureAuthority(actor: ScopeActor, what = "this action"): void {
  if (!hasTenantWideStructureAuthority(actor)) {
    throw scopeDenied(`Only an organisation administrator can perform ${what}; a department manager works inside their own department`);
  }
}

/**
 * Structural changes to a department itself (move, deactivate) are the PARENT's
 * call: a head administers what is below their department, not their own place
 * in the tree. A top-level department has no parent, so only tenant-wide
 * authority may restructure it.
 */
export async function assertCanRestructureDepartment(actor: ScopeActor, dept: { parentId: string | null }): Promise<void> {
  if (hasTenantWideStructureAuthority(actor)) return;
  if (!dept.parentId) {
    throw scopeDenied("Only an organisation administrator can change a top-level department");
  }
  await assertCanManageDepartment(actor, dept.parentId);
}

/** Departments of the tenant a user belongs to (membership rows joined to tenant-owned departments). */
async function departmentIdsOf(tenantId: string, userId: string): Promise<string[]> {
  const rows = await sequelize.query<{ id: string }>(
    `SELECT d.id FROM user_departments ud JOIN departments d ON d.id = ud.department_id
      WHERE ud.user_id = :userId AND d.tenant_id = :tenantId`,
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.id);
}

async function roleNamesOf(userId: string): Promise<string[]> {
  const rows = await sequelize.query<{ name: string }>(
    `SELECT r.name FROM roles r INNER JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.name);
}

/**
 * May the actor administer this user (edit, deactivate, delete, sign out,
 * assign/remove roles, set per-user permission overrides, change departments)?
 *
 *  1. The target must be a member of the actor's tenant — anything else reads as
 *     "user not found", the same answer a nonexistent id gives, so ids cannot
 *     be probed across tenants (and a stray user:manage holder in tenant A
 *     cannot deactivate a tenant-B user by guessing a UUID in development,
 *     where row-level security is inert).
 *  2. The target's effective permissions in this tenant must be a subset of the
 *     actor's: a department manager cannot demote, deactivate or re-permission
 *     a SYSTEM_ADMIN, an auditor or a records officer.
 *  3. Unless the actor has tenant-wide authority, the target must belong to a
 *     department the actor heads. `allowUnassigned` additionally lets a head
 *     adopt a tenant member who is in no department at all (onboarding) — the
 *     rules above still apply, so only people the head outranks.
 */
export async function assertCanManageUser(
  actor: ScopeActor,
  targetUserId: string,
  opts: { allowUnassigned?: boolean } = {},
): Promise<void> {
  const member = await UserTenant.findOne({ where: { userId: targetUserId, tenantId: actor.tenantId } });
  if (!member) throw userNotFound();

  if (targetUserId !== actor.userId) {
    const targetPerms = await resolveUnionPermissions(await roleNamesOf(targetUserId), actor.tenantId, targetUserId);
    const held = new Set(actor.permissions ?? []);
    const exceeds = targetPerms.filter((p) => !held.has(p));
    if (exceeds.length > 0) {
      throw new AppError(
        403,
        "ERR-TARGET-OUTRANKS-ACTOR",
        "You cannot manage a user who holds permissions you do not hold yourself",
        { permissions: exceeds },
      );
    }
  }

  if (hasTenantWideStructureAuthority(actor) || targetUserId === actor.userId) return;

  const [managed, targetDepts] = await Promise.all([
    getManagedDepartmentIds(actor.tenantId, actor.userId),
    departmentIdsOf(actor.tenantId, targetUserId),
  ]);
  if (targetDepts.some((id) => managed.has(id))) return;
  if (opts.allowUnassigned && targetDepts.length === 0) return;
  throw scopeDenied("This user is outside the departments you manage", "ERR-USER-SCOPE");
}

/** Every department in `departmentIds` must exist in the tenant and (unless tenant-wide) be one the actor heads. */
export async function assertDepartmentsInScope(actor: ScopeActor, departmentIds: readonly string[]): Promise<void> {
  if (departmentIds.length === 0) return;
  const unique = [...new Set(departmentIds)];
  const found = await Department.findAll({ where: { id: unique, tenantId: actor.tenantId }, attributes: ["id"] });
  if (found.length !== unique.length) {
    throw new AppError(404, "ERR-DEPARTMENT-NOT-FOUND", "Department not found");
  }
  if (hasTenantWideStructureAuthority(actor)) return;
  const managed = await getManagedDepartmentIds(actor.tenantId, actor.userId);
  if (unique.some((id) => !managed.has(id))) {
    throw scopeDenied("One or more departments are outside the departments you manage");
  }
}
