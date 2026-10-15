import { QueryTypes } from "sequelize";
import { Role, RolePermission, UserPermissionOverride, UserRole, UserTenant, User, sequelize } from "../../infrastructure/database/index.js";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "../../config/permissions.js";
import { assertNotHiddenUser, isPlatformAdminRoleName } from "../../shared/platformAdmin.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import {
  getCachedRolePermissions,
  cacheRolePermissions,
  invalidateRolePermissions,
  getCachedUserPermissionOverrides,
  cacheUserPermissionOverrides,
  invalidateUserPermissionOverrides,
  type ResolvedUserOverrides,
} from "../../infrastructure/cache/roleCache.js";
import { runInTransaction } from "../../shared/transaction.js";
import { logger } from "../../core/logger.js";
import { revokeAllUserSessions } from "../../shared/auth.js";

const VALID_PERMISSIONS = new Set(Object.values(PERMISSIONS));

function sortPermissions(permissions: Permission[]) {
  return [...new Set(permissions)].sort();
}

async function getRoleByName(roleName: string) {
  return Role.findOne({ where: { name: roleName } });
}

async function getStoredPermissions(roleId: string, tenantId: string): Promise<Permission[]> {
  const rows = await RolePermission.findAll({
    where: { roleId, tenantId },
    attributes: ["permission"],
    order: [["permission", "ASC"]],
    raw: true
  });

  return rows.map((row) => row.permission as Permission);
}

export async function getResolvedRolePermissions(roleName: string, tenantId: string): Promise<Permission[]> {
  const role = await getRoleByName(roleName);
  if (!role) {
    return sortPermissions((ROLE_PERMISSIONS[roleName] ?? []) as Permission[]);
  }

  return getRolePermissionsByRoleId(role.id, tenantId, role.name);
}

/**
 * The MAXIMUM permission set a role can confer in ANY tenant: the union of its
 * stored per-tenant permissions across EVERY tenant, plus the static fallback
 * (which applies in any tenant that has no stored rows for the role).
 *
 * Used by the C1 privilege-escalation guard. `user_roles` grants are GLOBAL
 * (the table has no tenantId), but `role_permissions` are per-tenant — so a role
 * that is weak in the actor's tenant may be elevated in another. Checking only
 * the actor's-tenant resolution would let an actor grant such a role and have
 * the grantee gain the elevated permissions after switching tenants (S19 audit
 * finding 2.1). The actor must hold a superset of THIS union to grant the role.
 */
export async function getMaxRolePermissionsAcrossTenants(roleName: string): Promise<Permission[]> {
  const staticFallback = (ROLE_PERMISSIONS[roleName] ?? []) as Permission[];
  const role = await getRoleByName(roleName);
  if (!role) {
    return sortPermissions(staticFallback);
  }
  const rows = await RolePermission.findAll({
    where: { roleId: role.id },
    attributes: ["permission"],
    raw: true,
  });
  const stored = rows.map((row) => row.permission as Permission);
  // Static fallback is always reachable: any tenant lacking stored rows resolves
  // the role to it, so it is part of what the role can confer somewhere.
  return sortPermissions([...stored, ...staticFallback]);
}

/**
 * Resolve the deduplicated, sorted UNION of permissions across every role a
 * user holds in a tenant. This is the single source of truth for the
 * "effective permissions" a JWT is stamped with — previously this
 * `Promise.all(...).flat() -> Set -> sort` incantation was copy-pasted at
 * every token-issuing site (login, select-tenant, switch-tenant, refresh,
 * MFA-validate, OIDC callback) and in the authenticate middleware fallback.
 *
 * `userId` is optional (omit to get the old role-only behavior) but every
 * token-issuing call site should pass it — it's how one specific person's
 * `user_permission_overrides` (IdP-managed, on top of their role) get baked
 * into their effective permission set.
 */
export async function resolveUnionPermissions(
  roleNames: string[],
  tenantId: string,
  userId?: string,
): Promise<Permission[]> {
  const permissionSets = await Promise.all(
    roleNames.map((roleName) => getResolvedRolePermissions(roleName, tenantId)),
  );
  const union = new Set(permissionSets.flat());
  if (!userId) {
    return sortPermissions([...union]);
  }

  const overrides = await getUserPermissionOverrides(userId, tenantId);
  overrides.grants.forEach((permission) => union.add(permission));
  overrides.revokes.forEach((permission) => union.delete(permission));
  return sortPermissions([...union]);
}

async function getStoredOverrides(userId: string, tenantId: string): Promise<ResolvedUserOverrides> {
  const rows = await UserPermissionOverride.findAll({
    where: { userId, tenantId },
    attributes: ["permission", "effect"],
    raw: true,
  });
  const grants: Permission[] = [];
  const revokes: Permission[] = [];
  for (const row of rows) {
    (row.effect === "GRANT" ? grants : revokes).push(row.permission as Permission);
  }
  return { grants: sortPermissions(grants), revokes: sortPermissions(revokes) };
}

/**
 * This user's individual permission overrides for a tenant — additive/subtractive
 * on top of whatever their role(s) resolve to. Cached the same way as
 * per-role permissions (300s TTL, Redis + LRU fallback).
 */
export async function getUserPermissionOverrides(userId: string, tenantId: string): Promise<ResolvedUserOverrides> {
  const cached = await getCachedUserPermissionOverrides(tenantId, userId);
  if (cached) {
    return cached;
  }
  const resolved = await getStoredOverrides(userId, tenantId);
  await cacheUserPermissionOverrides(tenantId, userId, resolved);
  return resolved;
}

/**
 * Replace one user's permission overrides wholesale (both the grant list and
 * the revoke list). Mirrors replaceRolePermissions's safety properties:
 * validates permission names, rejects a permission listed in both lists,
 * enforces the same C1 privilege-escalation guard on newly-added GRANTs
 * (REVOKE never needs it — it can only narrow what the target already has),
 * writes inside a transaction with cache invalidation deferred to afterCommit,
 * audit-logs the change, and revokes the target's live sessions so it takes
 * effect immediately rather than at next token expiry.
 */
/**
 * platform:admin is not a grantable permission. It exists only as part of the
 * PLATFORM_ADMIN role, which only the platform owner's seed script assigns. The
 * C1 escalation guard cannot enforce this on its own: the internal API principal
 * (the SSO console) holds every permission, so "you cannot grant what you do not
 * hold" never stops it.
 */
function assertNoReservedPermission(permissions: readonly string[]): void {
  if (permissions.includes(PERMISSIONS.PLATFORM_ADMIN)) {
    throw new AppError(400, "ERR-PERMISSION-RESERVED", "That permission cannot be granted");
  }
}

export async function replaceUserPermissionOverrides(
  userId: string,
  tenantId: string,
  grants: string[],
  revokes: string[],
  updatedById: string | undefined,
  actorPermissions: readonly Permission[],
  // Real actor identity ASSERTED by an internal-API caller (the SSO admin
  // console has no DMS user session to authenticate as — see
  // shared/internalAuth.ts's internalActor()). Only ever set on that path;
  // a normal DMS-authenticated caller passes updatedById instead and leaves
  // this undefined.
  assertedActor?: string | null,
): Promise<ResolvedUserOverrides> {
  // The platform admin is not editable by anyone, and no one can be handed its permission.
  await assertNotHiddenUser(userId, updatedById);
  assertNoReservedPermission(grants);
  const invalidPermissions = [...grants, ...revokes].filter(
    (permission) => !VALID_PERMISSIONS.has(permission as Permission),
  );
  if (invalidPermissions.length > 0) {
    throw new AppError(400, "ERR-INVALID-PERMISSION", "One or more permissions are invalid", {
      invalidPermissions,
    });
  }

  const overlap = grants.filter((permission) => revokes.includes(permission));
  if (overlap.length > 0) {
    throw new AppError(400, "ERR-CONFLICTING-OVERRIDE", "A permission cannot be both granted and revoked for the same user", {
      overlap,
    });
  }

  const user = await User.findByPk(userId, { attributes: ["id"] });
  if (!user) {
    throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  }
  // The override rows are written for THIS tenant, so the target must be one of
  // its members. Without this a user:manage holder could write overrides for —
  // and, through the session revocation below, sign out — a user of another
  // tenant just by knowing the id (RLS contains it in production only).
  const membership = await UserTenant.findOne({ where: { userId, tenantId }, attributes: ["userId"] });
  if (!membership) {
    throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  }

  const normalizedGrants = sortPermissions(grants as Permission[]);
  const normalizedRevokes = sortPermissions(revokes as Permission[]);

  const actorHeld = new Set(actorPermissions);
  const previous = await getStoredOverrides(userId, tenantId);
  const addedGrants = normalizedGrants.filter((permission) => !previous.grants.includes(permission));
  const cannotGrant = addedGrants.filter((permission) => !actorHeld.has(permission));
  if (cannotGrant.length > 0) {
    throw new AppError(403, "ERR-GRANT-EXCEEDS-ACTOR", "You cannot grant permissions you do not hold", {
      permissions: cannotGrant,
    });
  }

  await runInTransaction(async (transaction) => {
    await UserPermissionOverride.destroy({ where: { tenantId, userId }, transaction });

    const rows = [
      ...normalizedGrants.map((permission) => ({ tenantId, userId, permission, effect: "GRANT" as const })),
      ...normalizedRevokes.map((permission) => ({ tenantId, userId, permission, effect: "REVOKE" as const })),
    ];
    if (rows.length > 0) {
      await UserPermissionOverride.bulkCreate(rows, { transaction });
    }

    // R-04: the session cutoff is written in THIS transaction, so it commits
    // atomically with the override change. Previously this ran after the
    // transaction had already committed and had to swallow its own failure
    // with .catch(logger.warn) — throwing would have 500'd a change that did
    // apply — which meant a user stripped of permissions kept them until
    // token expiry whenever the Redis-only cutoff could not be written.
    // Atomic now: either the override change and the revocation both land,
    // or neither does.
    await revokeAllUserSessions(userId, {
      transaction,
      reason: 'user-permission-override-change',
    });

    // Same afterCommit reasoning as replaceRolePermissions — invalidating
    // eagerly here would race a rollback if runInTransaction reused the
    // request's ambient transaction.
    transaction.afterCommit(() => {
      void invalidateUserPermissionOverrides(tenantId, userId).catch((err) => {
        logger.warn({ err, tenantId, userId }, "Failed to invalidate user permission override cache after commit");
      });
    });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.USER_PERMISSION_OVERRIDES_UPDATED,
    userId: updatedById ?? null,
    tenantId,
    actionDetails: {
      targetUserId: userId,
      tenantId,
      grants: normalizedGrants,
      revokes: normalizedRevokes,
      ...(assertedActor
        ? { assertedActor, actorAssertedByInternalCaller: true }
        : {}),
    },
  });

  return { grants: normalizedGrants, revokes: normalizedRevokes };
}

export async function getRolePermissionsByRoleId(
  roleId: string,
  tenantId: string,
  fallbackRoleName?: string
): Promise<Permission[]> {
  const cached = await getCachedRolePermissions(tenantId, roleId);
  if (cached) {
    return cached;
  }

  const stored = await getStoredPermissions(roleId, tenantId);
  let resolved: Permission[];
  if (stored.length > 0) {
    resolved = sortPermissions(stored);
  } else {
    let roleName = fallbackRoleName;
    if (!roleName) {
      const role = await Role.findByPk(roleId, { attributes: ["name"] });
      if (!role) {
        throw new AppError(404, "ERR-ROLE-NOT-FOUND", "Role not found");
      }
      roleName = role.name;
    }
    resolved = sortPermissions((ROLE_PERMISSIONS[roleName] ?? []) as Permission[]);
  }

  await cacheRolePermissions(tenantId, roleId, resolved);
  return resolved;
}

export async function replaceRolePermissions(
  roleId: string,
  tenantId: string,
  permissions: string[],
  updatedById: string | undefined,
  actorPermissions: readonly Permission[],
  // See replaceUserPermissionOverrides's identical parameter doc comment.
  assertedActor?: string | null,
): Promise<Permission[]> {
  const invalidPermissions = permissions.filter((permission) => !VALID_PERMISSIONS.has(permission as Permission));
  if (invalidPermissions.length > 0) {
    throw new AppError(400, "ERR-INVALID-PERMISSION", "One or more permissions are invalid", {
      invalidPermissions
    });
  }

  const role = await Role.findByPk(roleId, { attributes: ["id", "name"] });
  // The platform-admin role reads as nonexistent: its permissions cannot be
  // shown, narrowed or widened by anyone (removals bypass the escalation guard,
  // so without this a role:manage holder could strip it).
  if (!role || isPlatformAdminRoleName(role.name)) {
    throw new AppError(404, "ERR-ROLE-NOT-FOUND", "Role not found");
  }
  assertNoReservedPermission(permissions);

  const normalized = sortPermissions(permissions as Permission[]);

  // PRIVILEGE-ESCALATION GUARD (C1): a role editor may only grant permissions
  // they themselves hold. Otherwise a DEPT_MANAGER (who has role:manage) could
  // add acl:bypass_admin / tenant:manage to a role and assign it to themselves,
  // becoming a de-facto super-admin. We check the DELTA being added against the
  // previous set, so preserving a pre-existing permission the actor lacks is
  // still allowed (it removes nothing and grants nothing new).
  const actorHeld = new Set(actorPermissions);
  const previous = new Set(await getStoredPermissions(roleId, tenantId));
  const nowStored = previous.size > 0
    ? previous
    : new Set(((ROLE_PERMISSIONS[role.name] ?? []) as Permission[]));
  const added = normalized.filter((p) => !nowStored.has(p));
  const cannotGrant = added.filter((p) => !actorHeld.has(p));
  if (cannotGrant.length > 0) {
    throw new AppError(403, "ERR-GRANT-EXCEEDS-ACTOR", "You cannot grant permissions you do not hold", {
      permissions: cannotGrant,
    });
  }

  await runInTransaction(async (transaction) => {
    await RolePermission.destroy({
      where: { tenantId, roleId },
      transaction
    });

    if (normalized.length > 0) {
      await RolePermission.bulkCreate(
        normalized.map((permission) => ({
          tenantId,
          roleId,
          permission
        })),
        { transaction }
      );
    }

    // FIX (runInTransaction conversion): invalidateRolePermissions() used to
    // run right after the managed `sequelize.transaction()` call returned,
    // which — back when that call always opened its own independent
    // transaction — really did mean "after commit". Now that it can reuse the
    // ambient request transaction, returning from the callback no longer
    // means committed (the real commit happens later, at response-finish
    // time — see shared/middleware.ts). Invalidating eagerly here would race
    // a rollback: a request that fails after this point would leave the role
    // permission cache invalidated for a permission change that never
    // actually happened. tx.afterCommit is the one hook that fires at the
    // true commit point whether this call reused the ambient transaction or
    // opened a fresh one.
    // R-04: the permission set is baked into every holder's JWT, so each of
    // them needs a cutoff — and those cutoffs belong in THIS transaction,
    // committing atomically with the permission change. This used to run
    // after the commit with .catch(logger.warn) per holder, so a role
    // demotion silently left every holder's stale permissions live until
    // token expiry if the Redis-only cutoff write failed.
    //
    // Holders are read inside the transaction as well, so a membership
    // change racing this one cannot leave a holder un-revoked.
    const holders = await UserRole.findAll({
      where: { roleId },
      attributes: ["userId"],
      raw: true,
      transaction,
    });
    for (const holderId of new Set(holders.map((h) => h.userId))) {
      // Sequential, not Promise.all: these are upserts onto the same table
      // inside one transaction, and concurrent writes there would contend
      // on row locks for no gain.
      await revokeAllUserSessions(holderId, {
        transaction,
        reason: `role-permission-change:${role.name}`,
      });
    }

    transaction.afterCommit(() => {
      void invalidateRolePermissions(tenantId, roleId).catch((err) => {
        logger.warn({ err, tenantId, roleId }, "Failed to invalidate role permission cache after commit");
      });
    });
  });

  // Security-critical: awaited so the audit row is written atomically with the
  // permission change (fails the operation on audit failure).
  await writeAuditLog({
    eventType: AUDIT_EVENTS.ROLE_PERMISSIONS_UPDATED,
    userId: updatedById ?? null,
    tenantId,
    actionDetails: {
      roleId,
      roleName: role.name,
      tenantId,
      permissionCount: normalized.length,
      ...(assertedActor
        ? { assertedActor, actorAssertedByInternalCaller: true }
        : {}),
    },
  });

  // Holders were revoked inside the transaction above (R-04), so that the
  // cutoffs and the permission change commit as one unit.
  return normalized;
}

/**
 * Read-only view of idp_role_mappings (the ad_group_dn -> role_name fallback
 * auth.service.ts's OIDC callback consults when an id_token's roles claim is
 * empty — see EDAMS_ROLES_CLAIM/AD_GROUPS_CLAIM there). This table is owned
 * by DMS, but until now had no DMS-side UI at all — only reachable by writing
 * to it via roles/internal.routes.ts's shared-secret API, which only the
 * separate SSO/IdP admin console calls. This is read-only: the SSO console
 * stays the system of record for writes (see 008_client_scoped_roles.sql's
 * header in that repo).
 */
export async function listIdpRoleMappings(): Promise<{ adGroupDn: string; roleName: string }[]> {
  const rows = await sequelize.query<{ ad_group_dn: string; role_name: string }>(
    `SELECT ad_group_dn, role_name FROM idp_role_mappings WHERE relying_party = 'edams' ORDER BY role_name ASC, ad_group_dn ASC`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => ({ adGroupDn: r.ad_group_dn, roleName: r.role_name }));
}

/** The built-in roles: the keys of ROLE_PERMISSIONS (seeded, referenced by name all over the code). Everything else is a custom role. */
export function isBuiltInRoleName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, name);
}

/** Change a CUSTOM role's description. The NAME is deliberately not editable: approval recipes, pending steps, status rules and
 *  the SSO group mappings refer to a role by name, so a rename would silently orphan them. (Create a new role and move people.) */
export async function updateCustomRoleDescription(roleId: string, description: string | null, actor: { userId: string; role?: string; tenantId: string }) {
  const role = await Role.findByPk(roleId);
  if (!role || isPlatformAdminRoleName(role.name)) throw new AppError(404, "ERR-ROLE-NOT-FOUND", "Role not found");
  if (isBuiltInRoleName(role.name)) throw new AppError(409, "ERR-ROLE-BUILT-IN", "A built-in role's description is fixed");
  const before = role.description;
  await role.update({ description });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.ROLE_UPDATED,
    userId: actor.userId,
    userRole: actor.role,
    tenantId: actor.tenantId,
    actionDetails: { roleId, roleName: role.name, descriptionBefore: before, descriptionAfter: description },
  });
  return role;
}

/**
 * Delete a CUSTOM role. Refused (nothing changes) while anything still points at it, and each refusal says what and how many:
 *   - built-in roles never;
 *   - people who hold it (remove it from them first);
 *   - SSO group mappings that grant it (remove them in the SSO console first);
 *   - an active approval recipe step, or a pending approval or letter step, assigned to it by name.
 * The role's permission rows and any per-status action rules for it are removed with it. Recorded in the audit log.
 */
export async function deleteCustomRole(roleId: string, actor: { userId: string; role?: string; tenantId: string }) {
  const role = await Role.findByPk(roleId);
  if (!role || isPlatformAdminRoleName(role.name)) throw new AppError(404, "ERR-ROLE-NOT-FOUND", "Role not found");
  if (isBuiltInRoleName(role.name)) throw new AppError(409, "ERR-ROLE-BUILT-IN", "A built-in role cannot be deleted");

  const count = async (sql: string) => {
    const rows = await sequelize.query<{ n: string }>(sql, { replacements: { roleId, name: role.name }, type: QueryTypes.SELECT });
    return Number(rows[0]?.n ?? 0);
  };
  const holders = await count(`SELECT count(*)::text AS n FROM user_roles WHERE role_id = :roleId`);
  if (holders > 0)
    throw new AppError(409, "ERR-ROLE-IN-USE", `${holders} ${holders === 1 ? "person holds" : "people hold"} this role. Remove it from them first.`);
  const mappings = await count(`SELECT count(*)::text AS n FROM idp_role_mappings WHERE role_name = :name`);
  if (mappings > 0)
    throw new AppError(409, "ERR-ROLE-MAPPED", `${mappings} SSO group mapping${mappings === 1 ? "" : "s"} grant this role. Remove ${mappings === 1 ? "it" : "them"} in the SSO console first.`);
  const recipes = await count(
    `SELECT count(*)::text AS n FROM approval_chain_templates t
      WHERE t.is_active AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.steps) s WHERE s->>'assignedRole' = :name)`,
  );
  if (recipes > 0)
    throw new AppError(409, "ERR-ROLE-IN-RECIPE", `${recipes} active approval recipe${recipes === 1 ? " uses" : "s use"} this role in a step. Edit or switch ${recipes === 1 ? "it" : "them"} off first.`);
  const pending =
    (await count(`SELECT count(*)::text AS n FROM approval_steps WHERE status = 'PENDING' AND assigned_role = :name`)) +
    (await count(`SELECT count(*)::text AS n FROM letter_approval_steps WHERE status = 'PENDING' AND assigned_role = :name`));
  if (pending > 0)
    throw new AppError(409, "ERR-ROLE-HAS-PENDING-WORK", `${pending} pending approval step${pending === 1 ? " is" : "s are"} assigned to this role. Finish or reassign ${pending === 1 ? "it" : "them"} first.`);

  await runInTransaction(async (tx) => {
    await sequelize.query(`DELETE FROM document_status_action_roles WHERE role_name = :name`, { replacements: { name: role.name }, transaction: tx });
    await sequelize.query(`DELETE FROM role_permissions WHERE role_id = :roleId`, { replacements: { roleId }, transaction: tx });
    await sequelize.query(`DELETE FROM roles WHERE id = :roleId`, { replacements: { roleId }, transaction: tx });
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.ROLE_DELETED,
    userId: actor.userId,
    userRole: actor.role,
    tenantId: actor.tenantId,
    actionDetails: { roleId, roleName: role.name },
  });
  return { roleId, roleName: role.name };
}
