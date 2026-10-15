// SPRINT-2: user and role assignment logic will be reworked once permissions replace role checks.
import { z } from "zod";
import { Op, UniqueConstraintError } from "sequelize";
import sharp from "sharp";
import { AppError } from "../../core/AppError.js";
import {
  Department, Role, User, UserDepartment, UserRole, UserTenant, Document, AuthSession,
  DocLock, DocumentCheckout, ApprovalStep, ApprovalChain, AuditStageReview, LetterApprovalStep, Letter,
  WorkflowTask, WorkflowInstance, SignatureRecipient, SignatureRequest, sequelize,
} from "../../infrastructure/database/index.js";
import { logger } from "../../core/logger.js";
import { fanOut } from "../notifications/notifications.service.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { PERMISSIONS, userHasPermission, type Permission } from "../../config/permissions.js";
import { invalidateUserDepartments } from "../../infrastructure/cache/userDeptCache.js";
import { invalidateTenantACL } from "../../infrastructure/cache/aclCache.js";
import { revokeAllUserSessions } from "../../shared/auth.js";
import { runInSavepoint, runInTransaction } from "../../shared/transaction.js";
import { getMaxRolePermissionsAcrossTenants } from "../roles/roles.service.js";
import { assertNotHiddenUser, excludeHiddenWhere, hiddenUserIds, isPlatformAdminRoleName } from "../../shared/platformAdmin.js";
import { assertDepartmentsInScope, hasTenantWideStructureAuthority } from "../../shared/orgScope.js";

const createUserSchema = z.object({
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  isActive: z.boolean().optional(),
  roleIds: z.array(z.string().uuid()).min(1, 'At least one role required'),
  departmentIds: z.array(z.string().uuid()).optional()
});

const updateUserSchema = createUserSchema.partial();

const userListInclude = [
  { 
    model: Role, 
    as: 'roles', 
    through: { attributes: [] }, 
    attributes: ['id', 'name'], 
    required: false 
  },
  {
    model: Department,
    as: 'departments',
    through: { attributes: [] },
    attributes: ['id', 'name', 'code', 'orgUnitId'],
    required: false
  }
];

/**
 * R-06 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): `users` has no tenant_id — membership
 * is many-to-many through `user_tenants` — and neither listUsers nor getUser
 * joined it. So GET /users returned EVERY user row in the database to any
 * user:manage holder, and GET /users/:id resolved any user id across tenant
 * boundaries. listUsers even accepted `requester.tenantId` and then never
 * used it for scoping.
 *
 * Production contained this through the non-superuser `edams_app` role and
 * the RLS policy in 20260710000001-rls-remaining-tenant-tables.sql, whose own
 * comment describes closing exactly this hole ("changes that endpoint's
 * result set from *every user in the system* to *members of my tenant*").
 * Development runs as `postgres`, where RLS is inert, so it was wide open
 * there — and relying on RLS alone left the application disagreeing with the
 * database about what the endpoint means. Closed here too, for the same
 * defence-in-depth reason as the getUserActivity fix.
 *
 * An INNER JOIN on user_tenants rather than an id IN (...) list: membership
 * scales with tenant headcount, and the join is index-served.
 */
function tenantMemberInclude(tenantId: string) {
  return { model: UserTenant, as: "userTenants", where: { tenantId }, required: true, attributes: [] as string[] };
}

export type ListUsersOptions = {
  skip?: number;
  take?: number;
  q?: string;
  roleId?: string;
  departmentId?: string;
  orgUnitId?: string;
  isActive?: 'active' | 'inactive';
  // "mine" scope (see departments.service.ts's getVisibleDepartmentIds):
  // when set, restricts the result to users who share at least one
  // department with the caller — the same opt-in `?scope=mine` pattern
  // already applied to GET /departments, /org-units and /document-types.
  // Every OTHER consumer of GET /users (AccessControlCenter's principal
  // picker, ApprovalChainsPanel, letters assignee pickers, the bulk
  // grant-ACL picker, etc.) legitimately needs to name any user in the
  // tenant and calls this route directly, not through the Users admin
  // table's hook, so they're unaffected by this being opt-in rather than
  // the default.
  visibleDepartmentIds?: Set<string>;
};

// Pagination follows the same skip/take convention as documents.routes.ts
// (GET /documents), default page size 15, capped at 100 per page — but ONLY
// when the caller explicitly asks for a page (opts.take set). This same `/users`
// endpoint doubles as an unpaginated "give me every user" data source for a
// handful of picker dropdowns elsewhere (AccessControlCenter, ApprovalChainsPanel,
// letters assignee pickers, admin crudPanels, bulk grant-ACL picker, etc.) —
// mirrors the "dropdown picker, not a paged list" convention already used for
// form templates in ApprovalChainsPanel. Only the Users admin table (the one
// with actual pagination controls) passes skip/take; every other consumer keeps
// getting the full list exactly as before.
export async function listUsers(requester: { role: string; tenantId: string; userId?: string }, opts: ListUsersOptions = {}) {
  const { skip = 0, take, q, roleId, departmentId, orgUnitId, isActive, visibleDepartmentIds } = opts;
  const paginate = take !== undefined;
  const safeTake = paginate ? Math.min(take!, 100) : undefined;
  const where: any = { deletedAt: null };

  // §1 FIX: Route middleware already gates via requirePermission(USER_MANAGE).
  // Service-level scope filtering is permission-based now.
  if (!userHasPermission(requester.role, PERMISSIONS.USER_MANAGE)) {
    throw new AppError(403, 'ERR-PERMISSION-DENIED', 'Permission denied');
  }

  if (q?.trim()) {
    const term = q.trim();
    where[Op.or] = [
      { firstName: { [Op.iLike]: `%${term}%` } },
      { lastName: { [Op.iLike]: `%${term}%` } },
      { email: { [Op.iLike]: `%${term}%` } },
    ];
  }
  if (isActive === 'active') where.isActive = true;
  if (isActive === 'inactive') where.isActive = false;

  // Role/department filters go through the M2M join tables directly rather
  // than `where` on the display include below — that include stays
  // required:false so each row still shows ALL of a user's roles/departments,
  // not just the one matched by the filter.
  const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';
  if (roleId) {
    const matches = await UserRole.findAll({ where: { roleId }, attributes: ['userId'] });
    const ids = matches.map((m) => m.userId);
    where.id = { [Op.in]: ids.length > 0 ? ids : [NO_MATCH_ID] };
  }
  if (departmentId) {
    const matches = await UserDepartment.findAll({ where: { departmentId }, attributes: ['userId'] });
    const ids = matches.map((m) => m.userId);
    if (where.id) {
      const existing = (where.id[Op.in] as string[]) ?? [];
      // FIX (Finding 16): `.includes()` inside `.filter()` was an O(existing *
      // ids) scan combining two user-ID lists that scale with tenant
      // headcount; a Set lookup makes the membership check O(1) per element.
      const idSet = new Set(ids);
      where.id = { [Op.in]: existing.filter((id) => idSet.has(id)) || [NO_MATCH_ID] };
    } else {
      where.id = { [Op.in]: ids.length > 0 ? ids : [NO_MATCH_ID] };
    }
  }
  // A department belongs to exactly one org unit, so "filter by org unit"
  // means "any department under it" -- resolve to that department set first,
  // then reuse the exact same UserDepartment -> userId lookup departmentId
  // uses above. Composes with an explicit departmentId via the same
  // intersect-with-existing-where.id pattern (harmless when the department
  // already belongs to the selected org unit; correctly empties the result
  // when someone mixes a department from a DIFFERENT org unit into the URL).
  if (orgUnitId) {
    const depts = await Department.findAll({ where: { tenantId: requester.tenantId, orgUnitId }, attributes: ['id'] });
    const deptIds = depts.map((d) => d.id);
    const matches = deptIds.length > 0
      ? await UserDepartment.findAll({ where: { departmentId: { [Op.in]: deptIds } }, attributes: ['userId'] })
      : [];
    const ids = matches.map((m) => m.userId);
    if (where.id) {
      const existing = (where.id[Op.in] as string[]) ?? [];
      const idSet = new Set(ids);
      where.id = { [Op.in]: existing.filter((id) => idSet.has(id)) || [NO_MATCH_ID] };
    } else {
      where.id = { [Op.in]: ids.length > 0 ? ids : [NO_MATCH_ID] };
    }
  }

  // "mine" scope: same intersect-with-existing-where.id pattern as
  // roleId/departmentId/orgUnitId above, restricting to users who share at
  // least one department with the caller. An empty visible set (caller
  // belongs to no department and holds no ACL grant) means "see no one",
  // not "see everyone" -- same default-deny used everywhere else this
  // pattern appears.
  if (visibleDepartmentIds) {
    const matches = visibleDepartmentIds.size > 0
      ? await UserDepartment.findAll({ where: { departmentId: { [Op.in]: Array.from(visibleDepartmentIds) } }, attributes: ['userId'] })
      : [];
    const ids = matches.map((m) => m.userId);
    if (where.id) {
      const existing = (where.id[Op.in] as string[]) ?? [];
      const idSet = new Set(ids);
      where.id = { [Op.in]: existing.filter((id) => idSet.has(id)) || [NO_MATCH_ID] };
    } else {
      where.id = { [Op.in]: ids.length > 0 ? ids : [NO_MATCH_ID] };
    }
  }

  // The platform administrator is absent from every list (shared/platformAdmin.ts).
  // Composed with Op.and so it survives whatever else already set where.id above.
  const hidden = await hiddenUserIds(requester.userId);
  if (hidden.length > 0) {
    where[Op.and] = [...((where[Op.and] as unknown[]) ?? []), excludeHiddenWhere(hidden)];
  }

  // R-06: both the page and its total are scoped to tenant members.
  const tenantScope = tenantMemberInclude(requester.tenantId);
  const [users, total] = await Promise.all([
    User.findAll({
      where,
      attributes: ["id", "email", "firstName", "lastName", "isActive", "isMfaEnabled", "lastLoginAt", "lockedUntil", "createdAt", "deletedAt"],
      include: [...userListInclude, tenantScope],
      order: [["createdAt", "DESC"]],
      offset: skip,
      limit: safeTake,
    }),
    // distinct so the join can never inflate the count (user_tenants is
    // unique per (user, tenant), but the count must not depend on that).
    User.count({ where, include: [tenantScope], distinct: true, col: "id" }),
  ]);

  // Serialize and flatten primary role to top-level `role` field
  const data = users.map(u => {
    const plain = u.get({ plain: true }) as any;
    // userRoles is the through-association; grab first role name
    const primaryRole = plain.roles?.[0]?.name ?? null;
    return { ...plain, role: primaryRole };
  });

  return { data, total, skip, take: safeTake };
}

export async function getUser(id: string, requester: { userId: string; role: string; tenantId: string }) {
  // §1 FIX: permission-based check instead of role-name check
  if (requester.userId !== id && !userHasPermission(requester.role, PERMISSIONS.USER_MANAGE)) {
    throw new AppError(403, "ERR-PERMISSION-DENIED", "Permission denied");
  }
  await assertNotHiddenUser(id, requester.userId);
  // R-06: a user id from another tenant must read as absent, not as a
  // profile. Reads 404 (not 403) deliberately — the same answer a
  // nonexistent id gives, so the endpoint cannot be used to probe which
  // user ids exist in other tenants.
  const user = await User.findOne({
    where: { id, deletedAt: null },
    attributes: ["id", "email", "firstName", "lastName", "isActive", "isMfaEnabled", "lastLoginAt", "createdAt"],
    include: [...userListInclude, tenantMemberInclude(requester.tenantId)]
  });
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  return user;
}

export async function getMe(userId: string) {
  const user = await User.findOne({
    where: { id: userId, deletedAt: null },
    attributes: ["id", "email", "firstName", "lastName", "isActive", "isMfaEnabled", "lastLoginAt", "createdAt", "signatureImage", "execNoticeOptOut"],
    include: [...userListInclude]
  });
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  return user;
}

// D8c: self-service handwritten-signature image. Stored as a small data URL;
// rendered into letter signatory blocks and signing ceremonies. Pass null to
// remove. Size-capped: this travels inside PDFs and user rows, not object
// storage.
//
// FIX 2026-09-14: was PNG/JPEG-only at 200 KB, both enforced by a regex on
// the client-declared data-URL prefix -- never actually verified against the
// bytes. letterPdf.ts's embedSignatureImage is the one thing that ever draws
// this into a document, and it calls pdf-lib's embedPng/embedJpg -- pdf-lib
// itself has no native WEBP/GIF embed support, so simply widening the accepted
// mime list here would have made those uploads succeed and then silently
// vanish from every letter (embedSignatureImage swallows embed errors so a
// bad capture can never block finalizing an already-numbered letter). Instead,
// every accepted format is decoded and re-encoded to a canonical PNG with
// sharp (already a project dependency) right here at save time, so the stored
// value -- and everything downstream that reads it -- is always exactly the
// PNG data URL it was before, regardless of what the user uploaded. sharp
// decodes from the real file bytes, not the caller-declared prefix, which also
// closes the gap where the old regex trusted that prefix outright.
const SIGNATURE_IMAGE_MAX_INPUT_BYTES = 5 * 1024 * 1024; // pre-decode cap, guards against a decode-bomb image
const SIGNATURE_IMAGE_MAX_BYTES = 1024 * 1024; // post-conversion cap on the stored PNG
const SIGNATURE_IMAGE_INPUT_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i;
export async function setSignatureImage(userId: string, signatureImage: string | null) {
  if (signatureImage !== null) {
    const match = typeof signatureImage === "string" ? SIGNATURE_IMAGE_INPUT_PATTERN.exec(signatureImage.trim()) : null;
    if (!match)
      throw new AppError(422, "ERR-SIGNATURE-IMAGE-INVALID", "Signature image must be a PNG, JPEG, WEBP, or GIF");
    const rawBytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
    if (rawBytes.length > SIGNATURE_IMAGE_MAX_INPUT_BYTES)
      throw new AppError(422, "ERR-SIGNATURE-IMAGE-TOO-LARGE", "Signature image is too large to process");

    let pngBytes: Buffer;
    try {
      pngBytes = await sharp(rawBytes).png().toBuffer();
    } catch {
      throw new AppError(422, "ERR-SIGNATURE-IMAGE-INVALID", "Signature image file is corrupted or not a supported image");
    }
    if (pngBytes.length > SIGNATURE_IMAGE_MAX_BYTES)
      throw new AppError(422, "ERR-SIGNATURE-IMAGE-TOO-LARGE", "Signature image must be under 1 MB");
    signatureImage = `data:image/png;base64,${pngBytes.toString("base64")}`;
  }
  const user = await User.findOne({ where: { id: userId, deletedAt: null } });
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  await user.update({ signatureImage });
  return { success: true, hasSignatureImage: signatureImage !== null };
}

// D10: per-executive opt-out from approved-letter notice emails.
export async function setExecNoticeOptOut(userId: string, optOut: boolean) {
  const user = await User.findOne({ where: { id: userId, deletedAt: null } });
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  await user.update({ execNoticeOptOut: Boolean(optOut) });
  return { success: true, execNoticeOptOut: Boolean(optOut) };
}

// L3: self-service email notification preferences. Defaults are "on" — an
// absent key means the user never opted out. Compliance emails (disposal
// warnings, purge notices) and external-recipient emails ignore these.
const notificationPrefsSchema = z.object({
  emailOnWorkflow: z.boolean().optional(),
  emailOnLegalHold: z.boolean().optional(),
  emailOnSystem: z.boolean().optional(),
});

export async function getNotificationPrefs(userId: string) {
  const user = await User.findOne({ where: { id: userId, deletedAt: null }, attributes: ["id", "notificationPrefs"] });
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  return {
    emailOnWorkflow: user.notificationPrefs?.emailOnWorkflow !== false,
    emailOnLegalHold: user.notificationPrefs?.emailOnLegalHold !== false,
    emailOnSystem: user.notificationPrefs?.emailOnSystem !== false,
  };
}

export async function setNotificationPrefs(userId: string, input: unknown) {
  const patch = notificationPrefsSchema.parse(input);
  const user = await User.findOne({ where: { id: userId, deletedAt: null } });
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");
  await user.update({ notificationPrefs: { ...user.notificationPrefs, ...patch } });
  return getNotificationPrefs(userId);
}

export async function createUser(
  input: unknown,
  requester: { userId: string; tenantId: string; permissions: readonly Permission[] },
) {
  const data = createUserSchema.parse(input);
  // Guard every requested role against the actor's own permissions (C1) BEFORE
  // creating anything, so a limited admin cannot mint a super-admin account.
  for (const roleId of data.roleIds) {
    // The platform-admin role is never handed out through the app (same rule
    // as assignRole): without this a platform admin creating a user could mint
    // a second one, because the C1 guard alone is satisfied by its own holder.
    await assertRoleIsAssignable(roleId);
    await assertCanGrantRole(roleId, requester.permissions);
  }
  // Scope (shared/orgScope.ts): every department named must exist in THIS
  // tenant (it used to be attached without any tenant check), and a department
  // head can only create people into departments they head — and must name
  // one, otherwise the new user would belong to nobody and be unmanageable by
  // the person who just created them.
  if (!hasTenantWideStructureAuthority(requester) && !data.departmentIds?.length) {
    throw new AppError(422, "ERR-DEPARTMENT-REQUIRED", "Choose at least one of your departments for the new user");
  }
  await assertDepartmentsInScope(requester, data.departmentIds ?? []);
  const requesterId = requester.userId;
  const email = data.email.toLowerCase();

  // Pre-check for a clean 409 instead of letting `users.email UNIQUE` surface
  // as an unhandled 500 — email is tenant-independent (one `users` row can
  // belong to several tenants via user_tenants), so this has to be a real
  // lookup, not something scoped away by the current tenant.
  const existing = await User.findOne({ where: { email }, attributes: ["id"] });
  if (existing) {
    throw new AppError(409, "ERR-USER-EMAIL-EXISTS", `A user with email "${email}" already exists`);
  }

  // returning:false — under RLS, INSERT..RETURNING requires the new row to be
  // visible via the SELECT policy, but users are visible only through their
  // user_tenants link, which can't exist before the row does (id/values are
  // all client-generated, so nothing needs to be read back).
  // (Sequelize types the returning:false overload as Promise<void>, but create()
  // still returns the built instance — only DB-generated fields go unread, and
  // every field here including the UUID id is client-generated.)
  let user: User;
  try {
    user = (await User.create({
      email,
      passwordHash: null,
      firstName: data.firstName,
      lastName: data.lastName,
      isActive: data.isActive ?? true,
      mustChangePassword: false
    }, { returning: false })) as unknown as User;
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw new AppError(409, "ERR-USER-EMAIL-EXISTS", `A user with email "${email}" already exists`);
    }
    throw err;
  }

  // Membership in the creating tenant — without this row the new user is
  // invisible under that tenant's RLS context (list/deactivate would 404) and
  // login only works via the legacy default-tenant fallback.
  await UserTenant.create({ userId: user.id, tenantId: requester.tenantId, assignedBy: requesterId });

  await UserRole.bulkCreate(data.roleIds.map((roleId) => ({ userId: user.id, roleId, assignedBy: requesterId })));
  if (data.departmentIds?.length) {
    const departmentIds = data.departmentIds;
    await runInTransaction(async (tx) => {
      await UserDepartment.bulkCreate(
        departmentIds.map((departmentId) => ({ userId: user.id, departmentId })),
        { transaction: tx },
      );
      for (const departmentId of departmentIds) {
        await backfillDepartmentSnapshot(tx, { userId: user.id, requesterId, tenantId: requester.tenantId, departmentId });
      }
      // afterCommit, not called right after bulkCreate resolves: this tx may
      // be the request's own ambient transaction (doesn't commit until the
      // request finishes) — invalidating immediately would race a concurrent
      // read against still-uncommitted rows. Same pattern as acl.service.ts.
      tx.afterCommit(() => {
        void invalidateUserDepartments(requester.tenantId, user.id).catch((err) => {
          logger.warn({ err, tenantId: requester.tenantId, userId: user.id }, "Failed to invalidate user-departments cache after user creation commit");
        });
      });
    });
  }
  
  await writeAuditLog({ 
    eventType: AUDIT_EVENTS.USER_CREATED, 
    userId: requesterId,
    actionDetails: { targetUserId: user.id, email: user.email, roleIds: data.roleIds } 
  });
  
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName };
}

export async function updateUser(id: string, input: unknown, requesterId: string) {
  await assertNotHiddenUser(id, requesterId);
  const data = updateUserSchema.parse(input);
  const user = await User.findByPk(id);
  if (!user) throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found");

  // The update schema is createUserSchema.partial(), so it *accepts* roleIds /
  // departmentIds — but user.update() silently drops them (they are not columns),
  // making the C1 grant-guard vacuous and masking operator intent (S19 audit
  // finding 2.2). Reject them explicitly and direct role changes to the dedicated
  // C1-guarded endpoints (POST/DELETE /users/:id/roles) instead of no-op'ing.
  if (data.roleIds !== undefined || data.departmentIds !== undefined) {
    throw new AppError(
      400,
      "ERR-USE-ROLE-ENDPOINTS",
      "Role and department membership cannot be changed here; use the role/department assignment endpoints",
    );
  }

  // AUTH-2: the domain change and the session-revocation cutoff must commit
  // atomically. Previously `user.update()` committed as its own statement and
  // `revokeAllUserSessions(id)` ran afterward with no transaction — if the
  // cutoff write then failed, the account was already deactivated in the DB
  // but its existing JWT was never proven revoked, and `authenticate` has no
  // independent isActive check, so a deactivated user's token kept working
  // until natural expiry while the admin who deactivated them saw a
  // misleading 500 for a change that, in fact, already took effect.
  await runInTransaction(async (tx) => {
    await user.update(data, { transaction: tx });
    if (data.isActive === false) {
      await revokeAllUserSessions(id, { transaction: tx, reason: "user-deactivated" });
    }
  });

  // Run the offboarding sweep (M8) only after the deactivation is durably
  // committed — it has its own savepoint-based failure isolation already.
  if (data.isActive === false) {
    await trySweepDeactivatedUserWork(id);
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.USER_UPDATED,
    userId: requesterId,
    actionDetails: { targetUserId: id, updates: data }
  });
  
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, isActive: user.isActive };
}

/**
 * PRIVILEGE-ESCALATION GUARD (C1): an actor with USER_MANAGE may assign roles,
 * but must not grant a role carrying permissions they themselves lack —
 * otherwise a DEPT_MANAGER could assign themselves (or a new user) SYSTEM_ADMIN.
 * The actor must hold a superset of the role's permissions.
 *
 * The comparison uses the role's MAXIMUM permissions across ALL tenants, not the
 * actor's-tenant resolution: `user_roles` grants are global while
 * `role_permissions` are per-tenant, so a role that is weak in the actor's
 * tenant but elevated in another would otherwise launder a cross-tenant
 * escalation once the grantee switches tenants (S19 audit finding 2.1).
 */
async function assertCanGrantRole(roleId: string, actorPermissions: readonly Permission[]) {
  const role = await Role.findByPk(roleId, { attributes: ["id", "name"] });
  if (!role) throw new AppError(404, "ERR-ROLE-NOT-FOUND", "Role not found");
  const rolePerms = await getMaxRolePermissionsAcrossTenants(role.name);
  const actorHeld = new Set(actorPermissions);
  const exceeds = rolePerms.filter((p) => !actorHeld.has(p));
  if (exceeds.length > 0) {
    throw new AppError(403, "ERR-ASSIGN-EXCEEDS-ACTOR", "You cannot assign a role with permissions you do not hold", {
      permissions: exceeds,
    });
  }
}

/**
 * The platform-admin role is not a role anyone can hand out or take back in the
 * app: it reads as nonexistent, exactly as it does in every role list. It is
 * granted only by the platform owner's seed script and protected by the
 * database (triggers + vault password).
 */
async function assertRoleIsAssignable(roleId: string): Promise<void> {
  const role = await Role.findByPk(roleId, { attributes: ["id", "name"] });
  if (role && isPlatformAdminRoleName(role.name)) {
    throw new AppError(404, "ERR-ROLE-NOT-FOUND", "Role not found");
  }
}

export async function assignRole(
  userId: string,
  roleId: string,
  assignedBy: string | undefined,
  _tenantId: string, // role grants are global; C1 guard now checks all tenants
  actorPermissions: readonly Permission[],
) {
  await assertNotHiddenUser(userId, assignedBy);
  await assertRoleIsAssignable(roleId);
  await assertCanGrantRole(roleId, actorPermissions);

  // AUTH-2: atomic with the role grant — see updateUser's comment above for
  // why an unguarded revoke call here left a grant that committed while its
  // revocation silently didn't.
  const row = await runInTransaction(async (tx) => {
    const [r] = await UserRole.findOrCreate({ where: { userId, roleId }, defaults: { userId, roleId, assignedBy }, transaction: tx });
    // Refresh the JWT permission union so the new role's permissions apply now (H9).
    await revokeAllUserSessions(userId, { transaction: tx, reason: "role-assigned" });
    // Mark this user's roles as DMS-admin-managed so auth.service.ts's OIDC
    // callback keeps this edit on the next login instead of silently
    // reverting it to the SSO id_token's roles claim (see rolesManagedLocally
    // on the User model) — this is what makes assigning a role from DMS's
    // own admin UI actually stick for an SSO-authenticated user.
    await User.update({ rolesManagedLocally: true }, { where: { id: userId }, transaction: tx });
    return r;
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.ROLE_ASSIGNED,
    userId: assignedBy ?? null,
    actionDetails: { targetUserId: userId, roleId },
  });
  return row;
}

export async function removeRole(userId: string, roleId: string, removedBy?: string) {
  await assertNotHiddenUser(userId, removedBy);
  await assertRoleIsAssignable(roleId);
  // AUTH-2: atomic with the role removal — see updateUser's comment above.
  await runInTransaction(async (tx) => {
    await UserRole.destroy({ where: { userId, roleId }, transaction: tx });
    // Permissions are baked into the JWT; force re-auth so the demotion takes
    // effect immediately instead of at token expiry (H9).
    await revokeAllUserSessions(userId, { transaction: tx, reason: "role-removed" });
    // See assignRole's comment: this is a DMS-admin-managed edit too.
    await User.update({ rolesManagedLocally: true }, { where: { id: userId }, transaction: tx });
  });
  await writeAuditLog({
    eventType: AUDIT_EVENTS.ROLE_REMOVED,
    userId: removedBy ?? null,
    actionDetails: { targetUserId: userId, roleId },
  });
}

/**
 * Gives a person who has just joined a department the department's per-member read row on every older
 * document the snapshot policy covered. See assignDepartment.
 */
async function backfillDepartmentSnapshot(
  tx: import("sequelize").Transaction,
  p: { userId: string; requesterId: string; tenantId: string; departmentId: string },
) {
  await sequelize.query(
    `INSERT INTO acl_entries (id, tenant_id, resource_type, resource_id, principal_type, principal_id, effect, permission, granted_by_id, origin, created_at, updated_at)
         SELECT gen_random_uuid(), d.tenant_id, 'document', d.id, 'user', :userId, 'ALLOW', 'document:read', :requesterId, 'DEPT_SNAPSHOT', NOW(), NOW()
         FROM documents d
         WHERE d.tenant_id = :tenantId AND d.department_id = :departmentId AND d.deleted_at IS NULL
           AND (
             EXISTS (SELECT 1 FROM acl_entries s WHERE s.resource_type = 'document' AND s.resource_id = d.id AND s.origin = 'DEPT_SNAPSHOT')
             -- a document with no snapshot rows is either one uploaded when its department had no other member
             -- (give the newcomer the row) or a letter's document whose snapshot was withheld (leave it closed)
             OR (
               NOT EXISTS (SELECT 1 FROM letters l WHERE l.tenant_id = d.tenant_id
                           AND d.id IN (l.document_id, l.attachment_document_id, l.cover_sheet_document_id, l.signed_draft_document_id))
               AND NOT EXISTS (SELECT 1 FROM letter_attachments la WHERE la.document_id = d.id)
             )
           )
         ON CONFLICT DO NOTHING`,
        { replacements: p, transaction: tx },
      );
}

export async function assignDepartment(userId: string, departmentId: string, tenantId: string, requesterId: string) {
  await assertNotHiddenUser(userId, requesterId);
  return runInTransaction(async (tx) => {
    const department = await Department.findOne({ where: { id: departmentId, tenantId }, transaction: tx });
    if (!department) throw new AppError(404, "ERR-DEPARTMENT-NOT-FOUND", "Department not found");
    const [row, joined] = await UserDepartment.findOrCreate({
      where: { userId, departmentId },
      defaults: { userId, departmentId },
      transaction: tx,
    });
    if (joined) {
      // Documents carry a per-member read row written when they were uploaded (a "department snapshot"), so
      // someone who joins later had no row on any older document and could list the department's documents
      // (live scope) but not open them. Give the newcomer the same row on every document of this department
      // that the snapshot policy covered (those that already hold snapshot rows; a document whose snapshot was
      // withheld, such as a confidential letter's, has none and stays closed to them).
      await backfillDepartmentSnapshot(tx, { userId, requesterId, tenantId, departmentId });
      tx.afterCommit(() => { void invalidateTenantACL(tenantId).catch(() => {}); });
    }
    // COMP-2: department membership participates in authorization and ACL
    // resolution, so a grant must be recorded just like the mirror revoke.
    // Keep it inside the same transaction: an audit row must never claim a
    // grant which failed to commit, or omit one that did.
    await writeAuditLog({
      eventType: AUDIT_EVENTS.USER_DEPT_ASSIGNED,
      userId: requesterId,
      actionDetails: { targetUserId: userId, departmentId },
    });
    tx.afterCommit(() => {
      void invalidateUserDepartments(tenantId, userId).catch((err) => {
        logger.warn({ err, tenantId, userId, departmentId }, "Failed to invalidate user-departments cache after department assignment commit");
      });
    });
    return row;
  });
}

export async function removeDepartment(userId: string, departmentId: string, tenantId: string, requesterId: string) {
  await assertNotHiddenUser(userId, requesterId);
  await runInTransaction(async (tx) => {
    const department = await Department.findOne({ where: { id: departmentId, tenantId }, transaction: tx });
    if (!department) throw new AppError(404, "ERR-DEPARTMENT-NOT-FOUND", "Department not found");
    await UserDepartment.destroy({ where: { userId, departmentId }, transaction: tx });
    // The mirror image: take back the snapshot read rows this department's documents gave the person.
    // (They were already ignored once the membership went; this removes the stale rows.)
    await sequelize.query(
      `DELETE FROM acl_entries
       WHERE tenant_id = :tenantId AND resource_type = 'document' AND principal_type = 'user' AND principal_id = :userId
         AND origin = 'DEPT_SNAPSHOT'
         AND resource_id IN (SELECT id FROM documents WHERE tenant_id = :tenantId AND department_id = :departmentId)`,
      { replacements: { userId, tenantId, departmentId }, transaction: tx },
    );
    tx.afterCommit(() => { void invalidateTenantACL(tenantId).catch(() => {}); });

    await writeAuditLog({
      eventType: AUDIT_EVENTS.USER_DEPT_REMOVED,
      userId: requesterId,
      actionDetails: { targetUserId: userId, departmentId }
    });

    // Security-relevant: a user whose department access was just revoked
    // must not keep resolving as still-provisioned via a stale cache entry
    // re-populated from a pre-commit read. Defer until the removal commits.
    tx.afterCommit(() => {
      void invalidateUserDepartments(tenantId, userId).catch((err) => {
        logger.warn({ err, tenantId, userId, departmentId }, "Failed to invalidate user-departments cache after department removal commit");
      });
    });
  });
}

export async function softDeleteUser(id: string, requesterId: string) {
  await assertNotHiddenUser(id, requesterId);
  if (id === requesterId)
    throw new AppError(409, 'ERR-SELF-DELETE', 'You cannot delete your own account');

  const user = await User.findByPk(id);
  if (!user) throw new AppError(404, 'ERR-USER-NOT-FOUND', 'User not found');

  // Block if user owns active documents
  const activeDocCount = await Document.count({
    where: { 
      ownerId: id, 
      deletedAt: null,
      status: { [Op.notIn]: ['CANCELLED', 'DISPOSED', 'ARCHIVED', 'PRESERVED'] } 
    }
  });
  if (activeDocCount > 0)
    throw new AppError(409, 'ERR-USER-HAS-ACTIVE-DOCS',
      `Cannot delete: user owns ${activeDocCount} active document(s). Reassign them first.`);

  // AUTH-2: atomic with the soft-delete — see updateUser's comment above.
  await runInTransaction(async (tx) => {
    await user.update({ deletedAt: new Date(), isActive: false }, { transaction: tx });

    // Revoke all sessions — both the DB session rows AND the JWT-level cutoff, so
    // live bearer/refresh tokens stop working immediately (C5).
    await AuthSession.update({ revokedAt: new Date() }, { where: { userId: id, revokedAt: null }, transaction: tx });
    await revokeAllUserSessions(id, { transaction: tx, reason: "user-soft-deleted" });
  });

  // Release locks/checkouts and surface stranded assignments (M8) — its own
  // savepoint-based failure isolation already, run after the delete commits.
  await trySweepDeactivatedUserWork(id);

  await writeAuditLog({ 
    eventType: AUDIT_EVENTS.USER_DELETED, 
    userId: requesterId,
    actionDetails: { targetUserId: id, email: user.email } 
  });
  return { success: true };
}

export async function activateUser(id: string, requesterId: string) {
  await assertNotHiddenUser(id, requesterId);
  const user = await User.findByPk(id);
  if (!user) throw new AppError(404, 'ERR-USER-NOT-FOUND', 'User not found');
  
  await user.update({ isActive: true, lockedUntil: null });
  
  await writeAuditLog({ 
    eventType: AUDIT_EVENTS.USER_ACTIVATED, 
    userId: requesterId,
    actionDetails: { targetUserId: id, email: user.email } 
  });
  return user;
}

/**
 * M8: offboarding sweep. Deactivating a user used to leave everything they
 * were in the middle of permanently stranded: documents they had locked or
 * checked out stayed blocked for everyone else (locks expire, checkouts
 * never do), and PENDING approval steps, audit reviews, and letter steps
 * assigned to them personally could sit unactionable forever — a deactivated
 * user can't log in to decide, and nothing surfaced the stuck work to anyone
 * who could reassign it.
 *
 * The sweep releases their locks/checkouts outright (both are advisory,
 * exclusive-editing state — safe to drop), and for assigned decision work it
 * notifies the person who can act (chain submitter, audit assigner, letter
 * owner) so they reassign or cancel via the existing endpoints. Best-effort
 * by design: a sweep failure must never block the deactivation itself, which
 * is a security action.
 */
async function sweepDeactivatedUserWork(userId: string) {
  const target = await User.findByPk(userId, { attributes: ["id", "firstName", "lastName", "email"] });
  const assigneeName = target
    ? `${target.firstName ?? ""} ${target.lastName ?? ""}`.trim() || target.email
    : "a deactivated user";
  const swept = { locks: 0, checkouts: 0, approvalSteps: 0, auditReviews: 0, letterSteps: 0, workflowTasks: 0, signatureRecipients: 0 };

  swept.locks = await DocLock.destroy({ where: { lockedBy: userId } });
  swept.checkouts = await DocumentCheckout.destroy({ where: { checkedOutBy: userId } });

  // Engine approval steps waiting on them personally → alert the submitter.
  const steps = await ApprovalStep.findAll({ where: { assignedUserId: userId, status: "PENDING" } });
  for (const step of steps) {
    const chain = await ApprovalChain.findByPk(step.chainId);
    if (!chain || chain.status !== "IN_REVIEW") continue;
    let title: string = chain.itemType;
    if (chain.itemType === "DOCUMENT") {
      const doc = await Document.findByPk(chain.itemId, { attributes: ["title"] });
      if (doc?.title) title = doc.title;
    }
    await fanOut({
      type: "ASSIGNEE_DEACTIVATED",
      tenantId: chain.tenantId,
      recipientIds: [chain.submittedBy],
      severity: "WARNING",
      payload: { itemType: chain.itemType, itemId: chain.itemId, title, assigneeName, stepId: step.id },
    });
    swept.approvalSteps++;
  }

  // Pending audit-stage reviews → alert whoever assigned the auditor (the
  // reassign-auditor endpoint exists for exactly this).
  const audits = await AuditStageReview.findAll({ where: { auditorUserId: userId, status: "PENDING" } });
  for (const audit of audits) {
    let title: string = audit.itemType;
    if (audit.itemType === "DOCUMENT") {
      const doc = await Document.findByPk(audit.itemId, { attributes: ["title"] });
      if (doc?.title) title = doc.title;
    }
    await fanOut({
      type: "ASSIGNEE_DEACTIVATED",
      tenantId: audit.tenantId,
      recipientIds: [audit.assignedBy],
      severity: "WARNING",
      payload: { itemType: audit.itemType, itemId: audit.itemId, title, assigneeName, auditReviewId: audit.id },
    });
    swept.auditReviews++;
  }

  // CAMS letter steps assigned to them → alert the letter owner (letters
  // already have reassignment + cancel-from-IN_REVIEW).
  const letterSteps = await LetterApprovalStep.findAll({
    where: { assignedUserId: userId, status: { [Op.in]: ["WAITING", "PENDING"] } },
  });
  for (const ls of letterSteps) {
    const letter = await Letter.findByPk(ls.letterId, {
      attributes: ["id", "tenantId", "subject", "createdBy", "status"],
    });
    if (!letter || letter.status !== "IN_REVIEW") continue;
    await fanOut({
      type: "ASSIGNEE_DEACTIVATED",
      tenantId: letter.tenantId,
      recipientIds: [letter.createdBy],
      severity: "WARNING",
      payload: { title: letter.subject, letterId: letter.id, assigneeName, stepId: ls.id },
    });
    swept.letterSteps++;
  }

  // Legacy workflow-engine tasks still assigned to (or delegated to) them → alert
  // the workflow initiator so they can reassign/cancel. Covers the assignee OR
  // delegate slot; only active (PENDING) tasks on still-running instances matter
  // (S19 audit finding — this table was previously missed by the sweep).
  const workflowTasks = await WorkflowTask.findAll({
    where: {
      status: "PENDING",
      [Op.or]: [{ assignedToUserId: userId }, { delegatedToUserId: userId }],
    },
  });
  for (const task of workflowTasks) {
    const instance = await WorkflowInstance.findByPk(task.workflowInstanceId, {
      attributes: ["id", "tenantId", "documentId", "initiatedById", "status"],
    });
    if (!instance || instance.status !== "ACTIVE") continue;
    let title = "a document";
    const doc = await Document.findByPk(instance.documentId, { attributes: ["title"] });
    if (doc?.title) title = doc.title;
    await fanOut({
      type: "ASSIGNEE_DEACTIVATED",
      tenantId: task.tenantId,
      recipientIds: [instance.initiatedById],
      severity: "WARNING",
      payload: { itemType: "DOCUMENT", itemId: instance.documentId, title, assigneeName, taskId: task.id, stageName: task.stageName },
    });
    swept.workflowTasks++;
  }

  // Pending internal e-sign recipients (dmsUserId = them, not yet signed) →
  // alert the ceremony creator so they can reassign/void; a deactivated internal
  // signer would otherwise permanently strand a live ceremony (they can no longer
  // log in and internal signers are notified in-app only). Only live requests
  // (S19 audit finding — this table was previously missed by the sweep).
  const sigRecipients = await SignatureRecipient.findAll({
    where: { dmsUserId: userId, status: { [Op.in]: ["pending", "viewed"] } },
  });
  for (const recipient of sigRecipients) {
    const request = await SignatureRequest.findByPk(recipient.signatureRequestId, {
      attributes: ["id", "documentId", "createdBy", "status"],
    });
    if (!request || !["sent", "partially_signed"].includes(request.status)) continue;
    if (!request.createdBy) continue;
    const doc = await Document.findByPk(request.documentId, { attributes: ["title", "tenantId"] });
    if (!doc?.tenantId) continue; // document gone → ceremony is moot
    await fanOut({
      type: "ASSIGNEE_DEACTIVATED",
      tenantId: doc.tenantId,
      recipientIds: [request.createdBy],
      severity: "WARNING",
      payload: { itemType: "DOCUMENT", itemId: request.documentId, title: doc?.title ?? "a document", assigneeName, signatureRequestId: request.id, recipientId: recipient.id },
    });
    swept.signatureRecipients++;
  }

  return swept;
}

async function trySweepDeactivatedUserWork(userId: string) {
  try {
    // Savepoint, not just try/catch: the sweep's queries ride the ambient
    // request transaction, and a single failed statement would abort that
    // whole transaction (25P02) — the catch below would swallow the JS error
    // while the deactivation's own commit then failed, rolling back the
    // security action this sweep must never block. On error the savepoint
    // also rolls back any partial sweep writes, so `null` in the audit row
    // reliably means "nothing swept" rather than "unknown subset swept".
    return await runInSavepoint(() => sweepDeactivatedUserWork(userId));
  } catch (err) {
    logger.error({ err, userId }, "M8 offboarding sweep failed — locks/assignments may need manual cleanup");
    return null;
  }
}

export async function deactivateUser(id: string, requesterId: string) {
  await assertNotHiddenUser(id, requesterId);
  // Same rule as deleting oneself (and as the SSO console, which refuses both): an administrator who
  // deactivates their own account ends their own session and may leave nobody able to undo it.
  if (id === requesterId)
    throw new AppError(409, 'ERR-SELF-DEACTIVATE', 'You cannot deactivate your own account');
  const user = await User.findByPk(id);
  if (!user) throw new AppError(404, 'ERR-USER-NOT-FOUND', 'User not found');
  
  // AUTH-2: atomic with the deactivation — see updateUser's comment above.
  await runInTransaction(async (tx) => {
    await user.update({ isActive: false }, { transaction: tx });

    // Kill live tokens immediately — otherwise a terminated employee keeps
    // authorizing every request until natural token expiry (C5).
    await revokeAllUserSessions(id, { transaction: tx, reason: "user-deactivated" });
  });

  const swept = await trySweepDeactivatedUserWork(id);

  await writeAuditLog({
    eventType: AUDIT_EVENTS.USER_DEACTIVATED,
    userId: requesterId,
    actionDetails: { targetUserId: id, email: user.email, offboardingSweep: swept }
  });
  return user;
}

export async function forceLogoutUser(id: string, requesterId: string) {
  await assertNotHiddenUser(id, requesterId);
  const user = await User.findByPk(id);
  if (!user) throw new AppError(404, 'ERR-USER-NOT-FOUND', 'User not found');
  
  // AUTH-2: atomic with the AuthSession revocation — see updateUser's comment above.
  await runInTransaction(async (tx) => {
    await AuthSession.update({ revokedAt: new Date() }, { where: { userId: id, revokedAt: null }, transaction: tx });
    // The AuthSession rows above are never consulted by the JWT auth path, so the
    // Redis cutoff is what actually forces re-authentication (C5).
    await revokeAllUserSessions(id, { transaction: tx, reason: "force-logout" });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.USER_FORCE_LOGOUT,
    userId: requesterId,
    actionDetails: { targetUserId: id, email: user.email }
  });
  return { success: true };
}

/**
 * A user's recent audit trail, for the Users admin detail drawer.
 *
 * Tenant-scoped explicitly. Every other audit read in this codebase carries
 * `tenantId: req.user.tenantId` in its where clause (audit.routes.ts's list /
 * export / by-document, documents.routes.ts's /:id/history,
 * legal-hold.routes.ts's chain-of-custody view); this one keyed on userId
 * alone, so the only thing standing between a `user:manage` holder and
 * another tenant's audit trail — event types, source IPs, document ids — was
 * knowing that user's UUID. RLS does contain it in production (audit_logs
 * carries audit_logs_tenant_isolation and prod connects as the non-superuser
 * `edams_app`), but it is inert in development, where DB_USER is the postgres
 * superuser, and relying on it alone made this the one audit query whose
 * isolation lived entirely outside the application.
 */
export async function getUserActivity(id: string, tenantId: string, viewerUserId?: string) {
  await assertNotHiddenUser(id, viewerUserId);
  const { AuditLog } = await import("../../infrastructure/database/index.js");
  return AuditLog.findAll({
    where: { userId: id, tenantId },
    order: [['timestamp', 'DESC']],
    limit: 50
  });
}
