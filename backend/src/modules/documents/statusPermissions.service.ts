/**
 * Document-status-conditioned permission matrix: lets an admin say "only
 * ROLE_A and ROLE_B may perform ACTION while a document is in STATUS", on top
 * of (never instead of) the normal RBAC + ACL checks every action already
 * enforces. Absence of any configured rule for a (tenant, status, action)
 * tuple means fully unrestricted — this feature only ever narrows, never
 * widens, what RBAC/ACL already allow.
 *
 * Modeled on roles.service.ts's role_permissions pattern: a DB-backed,
 * per-tenant, admin-editable table with a Redis+LRU cache invalidated on
 * write (see infrastructure/cache/statusPermissionCache.ts).
 */
import { AppError } from "../../core/AppError.js";
import { DocumentStatusActionRole } from "../../infrastructure/database/index.js";
import { documentStates } from "./DocumentStateMachine.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { runInTransaction } from "../../shared/transaction.js";
import { logger } from "../../core/logger.js";
import {
  getCachedStatusActionRoles,
  cacheStatusActionRoles,
  invalidateStatusActionRoles,
} from "../../infrastructure/cache/statusPermissionCache.js";

// The set of document actions this matrix can gate. Deliberately a fixed,
// curated list (not "any string") so an admin's rule always corresponds to a
// real enforcement point — see the assertStatusPermission call sites in
// documents.service.ts, trashService.ts, lockService.ts, previewService.ts.
export const STATUS_GATED_ACTIONS = [
  "read",
  "download",
  "preview",
  "checkout",
  "checkin",
  "upload_version",
  "rollback",
  "archive",
  "activate",
  "publish",
  "status_change",
  "lock",
  "unlock",
  "force_unlock",
  "trash",
  "restore",
  "delete_permanent",
  "purge_stage",
  "purge_approve",
  "purge_cancel",
] as const;

export type StatusGatedAction = (typeof STATUS_GATED_ACTIONS)[number];

const VALID_ACTIONS = new Set<string>(STATUS_GATED_ACTIONS);
const VALID_STATUSES = new Set<string>(documentStates);

export interface StatusPermissionRule {
  status: string;
  action: string;
  roles: string[];
}

/** All configured rules for a tenant, grouped by (status, action). Empty
 *  tuples (nothing configured) are simply absent — there's nothing to list. */
export async function listStatusPermissionRules(tenantId: string): Promise<StatusPermissionRule[]> {
  const rows = await DocumentStatusActionRole.findAll({
    where: { tenantId },
    order: [
      ["status", "ASC"],
      ["action", "ASC"],
      ["roleName", "ASC"],
    ],
    raw: true,
  });

  const grouped = new Map<string, StatusPermissionRule>();
  for (const row of rows) {
    const key = `${row.status}::${row.action}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { status: row.status, action: row.action, roles: [] };
      grouped.set(key, entry);
    }
    entry.roles.push(row.roleName);
  }
  return [...grouped.values()];
}

/**
 * Replace the allowed-roles set for one (status, action) tuple wholesale.
 * Passing an empty `roleNames` array clears the rule entirely (back to
 * unrestricted) rather than "restricted to nobody" — an admin removes a rule
 * by emptying it, the same UX as roles.service.ts's replaceRolePermissions.
 */
export async function setStatusPermissionRoles(
  tenantId: string,
  status: string,
  action: string,
  roleNames: string[],
  actor: { userId: string; role: string },
): Promise<StatusPermissionRule> {
  if (!VALID_STATUSES.has(status)) {
    throw new AppError(400, "ERR-INVALID-STATUS", `Unknown document status: ${status}`);
  }
  if (!VALID_ACTIONS.has(action)) {
    throw new AppError(400, "ERR-INVALID-ACTION", `Unknown gated action: ${action}`);
  }

  const uniqueRoles = [...new Set(roleNames)].filter(Boolean).sort();

  await runInTransaction(async (tx) => {
    await DocumentStatusActionRole.destroy({ where: { tenantId, status, action }, transaction: tx });
    if (uniqueRoles.length > 0) {
      await DocumentStatusActionRole.bulkCreate(
        uniqueRoles.map((roleName) => ({ tenantId, status, action, roleName, createdById: actor.userId })),
        { transaction: tx },
      );
    }

    // afterCommit, not right after the writes above — the request's ambient
    // transaction may not actually commit until response-finish time (see the
    // runInTransaction convention); invalidating eagerly would race
    // a rollback the same way roles.service.ts's replaceRolePermissions
    // already documents for its own cache.
    tx.afterCommit(() => {
      void invalidateStatusActionRoles(tenantId, status, action).catch((err) => {
        logger.warn({ err, tenantId, status, action }, "Failed to invalidate status-permission cache after commit");
      });
    });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_STATUS_PERMISSION_UPDATED,
    userId: actor.userId,
    userRole: actor.role,
    tenantId,
    actionDetails: { status, action, roles: uniqueRoles },
  });

  return { status, action, roles: uniqueRoles };
}

/**
 * The roles allowed to perform `action` on a document in `status`, or `null`
 * if nothing is configured for that tuple (i.e. unrestricted). Cached —
 * called on the hot path of nearly every document action.
 */
export async function getAllowedRolesFor(tenantId: string, status: string, action: string): Promise<string[] | null> {
  const cached = await getCachedStatusActionRoles(tenantId, status, action);
  if (cached !== null) {
    return cached.length > 0 ? cached : null;
  }

  const rows = await DocumentStatusActionRole.findAll({
    where: { tenantId, status, action },
    attributes: ["roleName"],
    raw: true,
  });
  const roles = rows.map((r) => r.roleName);
  await cacheStatusActionRoles(tenantId, status, action, roles);
  return roles.length > 0 ? roles : null;
}

/**
 * Enforce the matrix for one action on one document. A no-op (returns
 * normally) when nothing is configured for this (tenant, status, action) —
 * this function only ever narrows access, it never grants it, so an action
 * that already failed RBAC/ACL is never reached by this check in the first
 * place (call it alongside, not instead of, the existing guards).
 */
export async function assertStatusPermission(
  document: { tenantId?: string | null; status: string },
  action: StatusGatedAction,
  user: { role: string; roles?: readonly string[]; tenantId: string },
): Promise<void> {
  const tenantId = document.tenantId ?? user.tenantId;
  const allowedRoles = await getAllowedRolesFor(tenantId, document.status, action);
  if (!allowedRoles) return;

  // Check the user's FULL assigned-role set, not just the single display
  // role — mirrors resolveACL.ts's own reasoning (a user can hold a role
  // that isn't their highest-ranked display role).
  const userRoles = user.roles && user.roles.length > 0 ? user.roles : [user.role];
  if (!userRoles.some((r) => allowedRoles.includes(r))) {
    throw new AppError(
      403,
      "ERR-STATUS-ACTION-DENIED",
      `Only ${allowedRoles.join(", ")} may perform "${action}" on a document in ${document.status} status`,
    );
  }
}
