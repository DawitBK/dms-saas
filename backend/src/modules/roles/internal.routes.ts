// Internal admin API for the IdP's admin console (IdP/identity/src/admin/router.ts)
// to manage DMS role permissions and per-user permission overrides on an
// admin's behalf. Authenticated by a shared secret (shared/internalAuth.ts),
// not a user JWT — the IdP has no DMS user session to act under. Mounted
// directly (not under the normal `authenticate`-gated /api/v1 router) since
// requireInternalApiKey is its own auth, not a supplement to it.
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { asyncHandler } from '../../shared/asyncHandler.js';
import {
  internalActor,
  internalApiRateLimit,
  requireInternalApiKey,
} from '../../shared/internalAuth.js';
import { tenantContext } from '../../shared/middleware.js';
import { Role, sequelize } from '../../infrastructure/database/index.js';
import { AppError } from '../../core/AppError.js';
import { assertNotHiddenUser, isHiddenUser, isPlatformAdminRoleName, withoutPlatformAdminRole } from '../../shared/platformAdmin.js';
import {
  getRolePermissionsByRoleId,
  replaceRolePermissions,
  getUserPermissionOverrides,
  replaceUserPermissionOverrides,
} from './roles.service.js';
import { assertMappableRoleNames } from '../auth/ssoIdentity.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';

export const internalRolesRoutes = Router();
// Mounted on the '/tenants/:tenantId' prefix specifically (not a bare
// `.use(mw)`) so req.params.tenantId is already populated by Express's own
// path-param matching by the time these middlewares run — a bare `.use()`
// with no path runs before any route pattern (including this one's own
// ':tenantId' segment) has matched anything, so req.params would still be
// empty and tenantContext/requireInternalApiKey's own tenantId check would
// always fail.
internalRolesRoutes.use(
  '/tenants/:tenantId',
  // P1-10: throttle first, so a key-guessing loop is capped before it ever
  // reaches the comparison, and the allowlist/key rejections themselves cannot be
  // used as an unlimited oracle.
  internalApiRateLimit,
  asyncHandler(requireInternalApiKey),
  tenantContext,
);

const rolePermissionsSchema = z.object({
  permissions: z.array(z.string()),
});

const userOverridesSchema = z.object({
  grants: z.array(z.string()).default([]),
  revokes: z.array(z.string()).default([]),
});

// Array, not a nullable single string: a group (or a per-user "CN=user:<sub>"
// override) can assert more than one DMS role simultaneously now — see
// migration 20260923000002. An empty array means "no mapping" (equivalent to
// the old roleName: null case) rather than a separate null branch.
const roleMappingSchema = z.object({
  roleNames: z.array(z.string().trim().min(1).max(50)),
});

const resolveRoleMappingsSchema = z.object({
  groupDns: z.array(z.string().trim().min(1).max(512)).max(200),
});

const departmentAssignmentsSchema = z.object({
  departmentIds: z.array(z.string().uuid()).max(200),
});

async function getRoleMappings(groupDn: string): Promise<string[]> {
  const rows = await sequelize.query<{ role_name: string }>(
    `SELECT role_name
       FROM idp_role_mappings
      WHERE relying_party = 'edams' AND ad_group_dn = :groupDn
      ORDER BY role_name ASC`,
    { replacements: { groupDn }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.role_name);
}

function auditRoleState(roleNames: string[]): string {
  const joined = roleNames.join(',');
  return joined.length <= 50 ? joined : `${roleNames.length} roles`;
}

internalRolesRoutes.get(
  '/tenants/:tenantId/roles',
  asyncHandler(async (_req, res) => {
    const roles = await Role.findAll({
      order: [['name', 'ASC']],
      attributes: ['id', 'name', 'description'],
    });
    res.json({ data: withoutPlatformAdminRole(roles) });
  }),
);

internalRolesRoutes.get(
  '/tenants/:tenantId/departments',
  asyncHandler(async (req, res) => {
    const rows = await sequelize.query<{
      id: string;
      code: string;
      name: string;
      org_unit_id: string;
      org_unit_code: string;
      org_unit_name: string;
    }>(
      `SELECT d.id, d.code, d.name, d.org_unit_id,
              ou.code AS org_unit_code, ou.name AS org_unit_name
         FROM departments d
         JOIN org_units ou ON ou.id = d.org_unit_id
        WHERE d.tenant_id = :tenantId
          AND d.is_active = TRUE
          AND ou.is_active = TRUE
        ORDER BY ou.code ASC, d.code ASC`,
      {
        replacements: { tenantId: String(req.params.tenantId) },
        type: QueryTypes.SELECT,
      },
    );
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        orgUnitId: row.org_unit_id,
        orgUnitCode: row.org_unit_code,
        orgUnitName: row.org_unit_name,
      })),
    });
  }),
);

internalRolesRoutes.get(
  '/tenants/:tenantId/role-mappings',
  asyncHandler(async (_req, res) => {
    // A group mapped to the platform-admin role is the platform admin's own
    // personal group: it is not listed to anyone.
    const rows = await sequelize.query<{ group_dn: string }>(
      `SELECT DISTINCT ad_group_dn AS group_dn
       FROM idp_role_mappings
      WHERE relying_party = 'edams'
        AND ad_group_dn NOT IN (
          SELECT ad_group_dn FROM idp_role_mappings
           WHERE relying_party = 'edams' AND role_name = 'PLATFORM_ADMIN')
      ORDER BY ad_group_dn ASC`,
      { type: QueryTypes.SELECT },
    );
    res.json({ data: { groupDns: rows.map((row) => row.group_dn) } });
  }),
);

/**
 * Which groups carry a given DMS role: the inverse of the lookup above, for the SSO
 * admin console's Users filter ("everyone who is a RECORDS_OFFICER"). The mapping
 * lives only in this database, so SSO has to ask. The platform-admin role is never
 * answerable (empty), and a group that carries it is never returned for any role.
 */
internalRolesRoutes.get(
  '/tenants/:tenantId/role-mappings/by-role/:roleName',
  asyncHandler(async (req, res) => {
    const roleName = String(req.params.roleName);
    if (isPlatformAdminRoleName(roleName)) {
      res.json({ data: { roleName, groupDns: [] as string[] } });
      return;
    }
    const rows = await sequelize.query<{ group_dn: string }>(
      `SELECT DISTINCT ad_group_dn AS group_dn
         FROM idp_role_mappings
        WHERE relying_party = 'edams' AND role_name = :roleName
          AND ad_group_dn NOT IN (
            SELECT ad_group_dn FROM idp_role_mappings
             WHERE relying_party = 'edams' AND role_name = 'PLATFORM_ADMIN')
        ORDER BY ad_group_dn ASC`,
      { replacements: { roleName }, type: QueryTypes.SELECT },
    );
    res.json({ data: { roleName, groupDns: rows.map((r) => r.group_dn) } });
  }),
);

/** Resolve AD group DNs → DMS coarse role names for SSO token claims. */
internalRolesRoutes.post(
  '/tenants/:tenantId/role-mappings/resolve',
  asyncHandler(async (req, res) => {
    const { groupDns } = resolveRoleMappingsSchema.parse(req.body);
    if (groupDns.length === 0) {
      res.json({ data: { roles: [] as string[] } });
      return;
    }
    const rows = await sequelize.query<{ role_name: string }>(
      `SELECT DISTINCT role_name
         FROM idp_role_mappings
        WHERE relying_party = 'edams' AND ad_group_dn = ANY($1)
        ORDER BY role_name ASC`,
      { bind: [groupDns], type: QueryTypes.SELECT },
    );
    res.json({ data: { roles: rows.map((row) => row.role_name) } });
  }),
);

internalRolesRoutes.get(
  '/tenants/:tenantId/role-mappings/:groupDn',
  asyncHandler(async (req, res) => {
    const groupDn = String(req.params.groupDn);
    const roleNames = await getRoleMappings(groupDn);
    // A group that carries the platform-admin role reads as unmapped.
    res.json({ data: { groupDn, roleNames: roleNames.some(isPlatformAdminRoleName) ? [] : roleNames } });
  }),
);

internalRolesRoutes.put(
  '/tenants/:tenantId/role-mappings/:groupDn',
  asyncHandler(async (req, res) => {
    const groupDn = String(req.params.groupDn);
    const { roleNames } = roleMappingSchema.parse(req.body);
    const tenantId = String(req.params.tenantId);
    // Asserted by the internal caller (the SSO admin console), not
    // authenticated by DMS — see internalActor()'s doc comment. Recorded in
    // actionDetails, not the userId column: audit_logs.user_id is a real
    // Postgres UUID column with no FK, so an email string can't go there.
    const assertedActor = internalActor(req);
    const previousRoleNames = await getRoleMappings(groupDn);
    // The platform-admin role can be neither mapped to a group nor changed on a
    // group that already carries it: those mappings are written only by the
    // platform owner's seed script (vault-protected). Answered as a generic
    // validation failure, not as "forbidden", so it cannot be probed.
    if (roleNames.some(isPlatformAdminRoleName) || previousRoleNames.some(isPlatformAdminRoleName)) {
      throw new AppError(422, 'ERR-ROLE-INVALID', 'One or more roles are not valid');
    }
    // A mapping may only name roles DMS actually has (a typo used to be stored happily
    // and then silently ignored at every login of the group's members), and duplicates
    // are collapsed. See assertMappableRoleNames.
    const requestedRoleNames = await assertMappableRoleNames(roleNames);

    // Full replace, same shape as replaceRolePermissions below: delete every
    // row for this group, then insert exactly the requested set — the set
    // of roles this group's members hold IS these rows, not a merge with
    // whatever was there before. An empty roleNames array is a real
    // "unmap this group" case, same as the old roleName: null branch.
    await sequelize.transaction(async (tx) => {
      await sequelize.query(
        `DELETE FROM idp_role_mappings
        WHERE relying_party = 'edams' AND ad_group_dn = :groupDn`,
        { replacements: { groupDn }, type: QueryTypes.DELETE, transaction: tx },
      );
      for (const roleName of requestedRoleNames) {
        await sequelize.query(
          `INSERT INTO idp_role_mappings (relying_party, ad_group_dn, role_name)
           VALUES ('edams', :groupDn, :roleName)`,
          {
            replacements: { groupDn, roleName },
            type: QueryTypes.INSERT,
            transaction: tx,
          },
        );
      }
    });

    // FIX (Finding 2): this handler used to perform the mapping write with no
    // writeAuditLog call at all — raw SQL, no audit trail — unlike every
    // sibling write in this file. A group->role mapping change is exactly the
    // kind of thing SYSTEM-DECISIONS-level access auditing exists for (it
    // determines what role(s) every member of an AD group gets on SSO login).
    await writeAuditLog({
      eventType: AUDIT_EVENTS.ROLE_MAPPING_UPDATED,
      userId: null,
      tenantId,
      previousState: auditRoleState(previousRoleNames),
      newState: auditRoleState(requestedRoleNames),
      actionDetails: {
        groupDn,
        previousRoleNames,
        roleNames: requestedRoleNames,
        assertedActor,
        actorAssertedByInternalCaller: true,
      },
    });
    res.json({ data: { groupDn, roleNames: requestedRoleNames } });
  }),
);

internalRolesRoutes.get(
  '/tenants/:tenantId/users/by-email/:email/status',
  asyncHandler(async (req, res) => {
    const email = decodeURIComponent(String(req.params.email))
      .trim()
      .toLowerCase();
    const pendingRows = await sequelize.query<{ department_ids: string[] }>(
      `SELECT department_ids
         FROM sso_pending_department_assignments
        WHERE tenant_id = :tenantId AND email = :email`,
      {
        replacements: { tenantId: String(req.params.tenantId), email },
        type: QueryTypes.SELECT,
      },
    );
    // An email address alone is not a tenant boundary.  A DMS account may be
    // present in a different tenant, in which case this internal status call
    // must look exactly like an unprovisioned account for the requested
    // tenant.  This matches the membership check in the assignment endpoint
    // below and prevents cross-tenant role/department metadata disclosure.
    const users = await sequelize.query<{ id: string; is_active: boolean }>(
      `SELECT u.id, u.is_active
         FROM users u
         JOIN user_tenants ut
           ON ut.user_id = u.id AND ut.tenant_id = :tenantId
        WHERE lower(u.email) = :email AND u.deleted_at IS NULL
        LIMIT 1`,
      {
        replacements: { tenantId: String(req.params.tenantId), email },
        type: QueryTypes.SELECT,
      },
    );
    // A platform admin answers exactly like an unprovisioned account.
    const user = users[0] && !(await isHiddenUser(users[0].id)) ? users[0] : undefined;

    if (!user) {
      res.json({
        data: {
          exists: false,
          id: null,
          roles: [],
          departmentIds: [],
          pendingDepartmentIds: pendingRows[0]?.department_ids ?? [],
          active: null,
        },
      });
      return;
    }

    const roleRows = await sequelize.query<{ role_name: string }>(
      `SELECT r.name AS role_name
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = :userId
      ORDER BY r.name ASC`,
      { replacements: { userId: user.id }, type: QueryTypes.SELECT },
    );

    const departmentRows = await sequelize.query<{ department_id: string }>(
      `SELECT department_id FROM user_departments WHERE user_id = :userId ORDER BY department_id`,
      { replacements: { userId: user.id }, type: QueryTypes.SELECT },
    );
    res.json({
      data: {
        exists: true,
        id: user.id,
        roles: roleRows.map((row) => row.role_name),
        departmentIds: departmentRows.map((row) => row.department_id),
        pendingDepartmentIds: pendingRows[0]?.department_ids ?? [],
        active: user.is_active,
      },
    });
  }),
);

internalRolesRoutes.put(
  '/tenants/:tenantId/users/by-email/:email/departments',
  asyncHandler(async (req, res) => {
    const tenantId = String(req.params.tenantId);
    const email = decodeURIComponent(String(req.params.email))
      .trim()
      .toLowerCase();
    const { departmentIds } = departmentAssignmentsSchema.parse(req.body);
    const uniqueDepartmentIds = [...new Set(departmentIds)];

    const validDepartments = await sequelize.query<{ id: string }>(
      `SELECT d.id
         FROM departments d
         JOIN org_units ou ON ou.id = d.org_unit_id
        WHERE d.tenant_id = $1
          AND d.is_active = TRUE
          AND ou.is_active = TRUE
          AND d.id = ANY($2::uuid[])`,
      { bind: [tenantId, uniqueDepartmentIds], type: QueryTypes.SELECT },
    );
    if (validDepartments.length !== uniqueDepartmentIds.length) {
      throw new AppError(
        422,
        'ERR-DEPARTMENT-INVALID',
        'One or more departments are not active in the selected tenant and organizational units',
      );
    }

    const userRows = await sequelize.query<{ id: string }>(
      `SELECT u.id
         FROM users u
         JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = :tenantId
        WHERE lower(u.email) = :email AND u.deleted_at IS NULL
        LIMIT 1`,
      { replacements: { tenantId, email }, type: QueryTypes.SELECT },
    );
    const actor = internalActor(req);
    // Same: a platform admin is indistinguishable from "no such user yet".
    if (userRows.length > 0 && (await isHiddenUser(userRows[0].id))) userRows.length = 0;

    if (userRows.length === 0) {
      // An empty set is an explicit clear, not an assignment waiting to be
      // consumed at a later sign-in.  In particular, SSO's failed-create
      // compensation calls this endpoint with []; leaving an empty row here
      // made cleanup appear successful while retaining stale state forever.
      if (uniqueDepartmentIds.length === 0) {
        await sequelize.query(
          `DELETE FROM sso_pending_department_assignments
            WHERE tenant_id = :tenantId AND email = :email`,
          {
            replacements: { tenantId, email },
            type: QueryTypes.DELETE,
          },
        );
        res.json({ data: { email, departmentIds: [], pending: false } });
        return;
      }
      await sequelize.query(
        `INSERT INTO sso_pending_department_assignments (tenant_id, email, department_ids, assigned_by)
         VALUES ($1, $2, $3::uuid[], $4)
         ON CONFLICT (tenant_id, email) DO UPDATE SET
           department_ids = EXCLUDED.department_ids,
           assigned_by = EXCLUDED.assigned_by,
           updated_at = NOW()`,
        {
          bind: [tenantId, email, uniqueDepartmentIds, actor],
          type: QueryTypes.INSERT,
        },
      );
      res.json({
        data: { email, departmentIds: uniqueDepartmentIds, pending: true },
      });
      return;
    }

    const userId = userRows[0].id;
    await sequelize.transaction(async (tx) => {
      await sequelize.query(
        `DELETE FROM user_departments WHERE user_id = :userId`,
        {
          replacements: { userId },
          type: QueryTypes.DELETE,
          transaction: tx,
        },
      );
      if (uniqueDepartmentIds.length > 0) {
        await sequelize.query(
          `INSERT INTO user_departments (user_id, department_id)
           SELECT $1, unnest($2::uuid[])`,
          {
            bind: [userId, uniqueDepartmentIds],
            type: QueryTypes.INSERT,
            transaction: tx,
          },
        );
      }
      await sequelize.query(
        `DELETE FROM sso_pending_department_assignments WHERE tenant_id = :tenantId AND email = :email`,
        {
          replacements: { tenantId, email },
          type: QueryTypes.DELETE,
          transaction: tx,
        },
      );
      await writeAuditLog(
        {
          eventType:
            uniqueDepartmentIds.length > 0
              ? AUDIT_EVENTS.USER_DEPT_ASSIGNED
              : AUDIT_EVENTS.USER_DEPT_REMOVED,
          tenantId,
          userId: null,
          actionDetails: {
            targetUserId: userId,
            email,
            departmentIds: uniqueDepartmentIds,
            assertedActor: actor,
          },
        },
        tx,
      );
    });

    res.json({
      data: {
        email,
        userId,
        departmentIds: uniqueDepartmentIds,
        pending: false,
      },
    });
  }),
);

internalRolesRoutes.get(
  '/tenants/:tenantId/roles/:roleId/permissions',
  asyncHandler(async (req, res) => {
    const role = await Role.findByPk(String(req.params.roleId), {
      attributes: ['id', 'name'],
    });
    if (!role || isPlatformAdminRoleName(role.name)) {
      res.status(404).json({
        error: { code: 'ERR-ROLE-NOT-FOUND', message: 'Role not found' },
      });
      return;
    }
    const permissions = await getRolePermissionsByRoleId(
      role.id,
      String(req.params.tenantId),
      role.name,
    );
    res.json({ data: { roleId: role.id, roleName: role.name, permissions } });
  }),
);

internalRolesRoutes.put(
  '/tenants/:tenantId/roles/:roleId/permissions',
  asyncHandler(async (req, res) => {
    const parsed = rolePermissionsSchema.parse(req.body);
    // FIX (Finding 2): this used to pass req.user!.userId — the nil-UUID
    // sentinel requireInternalApiKey synthesizes for every internal-API
    // request — straight into the audit log as the actor, indistinguishable
    // from every other write through this surface. internalActor(req)
    // resolves the real asserted admin identity from x-internal-actor.
    const permissions = await replaceRolePermissions(
      String(req.params.roleId),
      String(req.params.tenantId),
      parsed.permissions,
      undefined,
      req.user!.permissions,
      internalActor(req),
    );
    res.json({ data: { roleId: String(req.params.roleId), permissions } });
  }),
);

internalRolesRoutes.get(
  '/tenants/:tenantId/users/:userId/permission-overrides',
  asyncHandler(async (req, res) => {
    await assertNotHiddenUser(String(req.params.userId));
    const overrides = await getUserPermissionOverrides(
      String(req.params.userId),
      String(req.params.tenantId),
    );
    res.json({ data: overrides });
  }),
);

internalRolesRoutes.put(
  '/tenants/:tenantId/users/:userId/permission-overrides',
  asyncHandler(async (req, res) => {
    const parsed = userOverridesSchema.parse(req.body);
    // See the sibling role-permissions handler above for why this no longer
    // passes req.user!.userId (the sentinel) as the actor.
    const overrides = await replaceUserPermissionOverrides(
      String(req.params.userId),
      String(req.params.tenantId),
      parsed.grants,
      parsed.revokes,
      undefined,
      req.user!.permissions,
      internalActor(req),
    );
    res.json({ data: overrides });
  }),
);
