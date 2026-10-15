/**
 * The platform administrator is invisible and untouchable.
 *
 * The PLATFORM_ADMIN role is the platform owner's account. To everyone else —
 * including SYSTEM_ADMIN, department managers, auditors and the SSO console —
 * that account does not exist: it is in no list, picker, role dropdown, audit
 * view or session view, cannot be edited, deactivated, deleted, signed out,
 * re-roled or re-permissioned, and a request that names it answers exactly like
 * a request for an id that was never there (404), so it cannot be probed.
 *
 * Only the platform admin itself sees its own row (self-service keeps working).
 *
 * This module is the single definition of "who is hidden" for the application
 * layer. The database repeats the rule independently (migration
 * 20261004000002-platform-admin-protection.sql: triggers refuse changes to the
 * account without the vault password, and a restrictive RLS policy hides the
 * row from other tenant-scoped sessions), so a future endpoint that forgets to
 * call this still cannot leak or modify it on a hardened database role.
 *
 * Do not add a "show platform admins" switch anywhere. If something needs to
 * reach the account, it goes through the vault (scripts/platform-vault.ts).
 */
import { Op, QueryTypes } from "sequelize";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sequelize } from "../infrastructure/database/sequelize.js";
import { AppError } from "../core/AppError.js";
import { PERMISSIONS } from "../config/permissions.js";

export const PLATFORM_ADMIN_ROLE = "PLATFORM_ADMIN";

const TTL_MS = 15_000;
let cache: { ids: string[]; at: number } | null = null;

/** Every user that holds the PLATFORM_ADMIN role. user_roles/roles carry no RLS, so this is
 *  readable from any context, including the pre-tenant auth paths. */
export async function getPlatformAdminUserIds(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids;
  const rows = await sequelize.query<{ user_id: string }>(
    `SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = :role`,
    { replacements: { role: PLATFORM_ADMIN_ROLE }, type: QueryTypes.SELECT },
  );
  cache = { ids: rows.map((r) => r.user_id), at: Date.now() };
  return cache.ids;
}

/** Call after anything that could change who holds the role (the seed script, a role sync). */
export function invalidatePlatformAdminCache(): void {
  cache = null;
}

/** The ids hidden from `viewerUserId`: every platform admin except the viewer themself. */
export async function hiddenUserIds(viewerUserId?: string | null): Promise<string[]> {
  const ids = await getPlatformAdminUserIds();
  return viewerUserId ? ids.filter((id) => id !== viewerUserId) : ids;
}

export async function isHiddenUser(targetUserId: string, viewerUserId?: string | null): Promise<boolean> {
  return (await hiddenUserIds(viewerUserId)).includes(targetUserId);
}

/** Sequelize `where` fragment excluding hidden users from a query on `users` (or any `userId` column). */
export function excludeHiddenWhere(hidden: string[], column = "id"): Record<string, unknown> {
  return hidden.length > 0 ? { [column]: { [Op.notIn]: hidden } } : {};
}

/** True when the role is the platform-admin role, which no one may select, list or edit. */
export function isPlatformAdminRoleName(name: string | null | undefined): boolean {
  return name === PLATFORM_ADMIN_ROLE;
}

/** Drop the platform-admin role from any role list shown to a person. */
export function withoutPlatformAdminRole<T extends { name?: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isPlatformAdminRoleName(r.name));
}

/** Does this request come from a platform admin? (permission, not role name) */
export function actorIsPlatformAdmin(user: { permissions?: readonly string[] } | undefined): boolean {
  return Boolean(user?.permissions?.includes(PERMISSIONS.PLATFORM_ADMIN));
}

export function userNotFound(): AppError {
  return new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
}

/**
 * Route guard: a request that targets a platform admin (other than the caller)
 * is answered as "user not found". Put it AFTER the permission check so the
 * permission response does not change.
 */
export function guardPlatformAdminTarget(param = "id"): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const target = String(req.params[param] ?? "");
      if (target && (await isHiddenUser(target, req.user?.userId))) throw userNotFound();
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Service-layer twin of the guard, for functions reachable without a route (internal API, workers). */
export async function assertNotHiddenUser(targetUserId: string, viewerUserId?: string | null): Promise<void> {
  if (await isHiddenUser(targetUserId, viewerUserId)) throw userNotFound();
}

/**
 * SQL predicate for raw queries: true when the user (given as a SQL expression such as
 * `u.id` or `ur.user_id`) is NOT a platform admin. Use it in every raw query that resolves
 * people by role, so the account is never picked, counted or notified.
 */
export function notPlatformAdminSql(userIdExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM user_roles _pa_ur JOIN roles _pa_r ON _pa_r.id = _pa_ur.role_id WHERE _pa_ur.user_id = ${userIdExpr} AND _pa_r.name = '${PLATFORM_ADMIN_ROLE}')`;
}

/** Drop hidden users from a list of user ids (the viewer, if they are the platform admin, keeps themself). */
export async function withoutHiddenIds(ids: string[], viewerUserId?: string | null): Promise<string[]> {
  if (ids.length === 0) return ids;
  const hidden = new Set(await hiddenUserIds(viewerUserId));
  return hidden.size === 0 ? ids : ids.filter((id) => !hidden.has(id));
}

/**
 * Narrow an `audit_logs` where-clause so rows produced by a hidden actor are not returned.
 * Rows written since the anonymisation (audit.service.ts) already carry no actor; this covers
 * the older, immutable rows that still do. Only a READ filter: the hash chain and its
 * verification are untouched, so the trail stays provably intact.
 */
export async function restrictAuditToVisibleActors<T extends Record<string | symbol, unknown>>(
  where: T,
  viewerUserId?: string | null,
): Promise<T> {
  const hidden = await hiddenUserIds(viewerUserId);
  if (hidden.length === 0) return where;
  const clause = { [Op.or]: [{ userId: null }, { userId: { [Op.notIn]: hidden } }] };
  (where as Record<symbol, unknown>)[Op.and] = [...(((where as Record<symbol, unknown>)[Op.and] as unknown[]) ?? []), clause];
  return where;
}

/** The platform administrator is invisible to everyone else, so a record they touched (a letter they drafted,
 *  approved or dispatched) must not name them. Walks a loaded record (model instances or plain objects) and
 *  replaces any included user record that is a hidden account with a neutral placeholder, and blanks
 *  any bare column holding a hidden id (creatorId, decidedBy, ...). The viewer's own account is never masked. */
const MASKED_USER_RECORD = { id: null, firstName: 'Former', lastName: 'user', email: null };
export async function maskHiddenUsersDeep(root: unknown, viewerUserId: string): Promise<void> {
  const hidden = new Set(await hiddenUserIds(viewerUserId));
  if (hidden.size === 0 || !root) return;
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    const holder = node as { dataValues?: Record<string, unknown> };
    const dv = (holder.dataValues ?? node) as Record<string, unknown>;
    for (const key of Object.keys(dv)) {
      const v = dv[key];
      if (typeof v === 'string' && hidden.has(v)) { dv[key] = null; continue; }
      if (!v || typeof v !== 'object' || v instanceof Date) continue;
      const inner = ((v as { dataValues?: Record<string, unknown> }).dataValues ?? v) as Record<string, unknown>;
      if (typeof inner.id === 'string' && hidden.has(inner.id) && 'firstName' in inner) dv[key] = { ...MASKED_USER_RECORD };
      else walk(v, depth + 1);
    }
  };
  walk(root, 0);
}
