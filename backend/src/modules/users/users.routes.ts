// SPRINT-2: user and role management routes must move from role checks to explicit permissions.
import { Router } from "express";
import { z } from "zod";
import { requirePermission, requireSelfOrPermission, requireAnyPermission } from "../../shared/auth.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { getUserPermissionOverrides, replaceUserPermissionOverrides } from "../roles/roles.service.js";
import { getVisibleDepartmentIds } from "../departments/departments.service.js";
import { guardPlatformAdminTarget } from "../../shared/platformAdmin.js";
import { assertCanManageDepartment, assertCanManageUser } from "../../shared/orgScope.js";
import {
  assignDepartment, 
  assignRole, 
  createUser, 
  getUser, 
  listUsers, 
  removeDepartment, 
  removeRole, 
  updateUser,
  getMe,
  setSignatureImage,
  setExecNoticeOptOut,
  getNotificationPrefs,
  setNotificationPrefs,
  softDeleteUser, 
  activateUser, 
  deactivateUser, 
  forceLogoutUser,
  getUserActivity,
} from "./users.service.js";

export const userRoutes = Router();

// Who a user:manage holder may administer (shared/orgScope.ts): a member of the
// caller's tenant, who does not outrank them, inside a department they head
// (tenant-wide administrators: anywhere). Runs AFTER the permission check and
// guardPlatformAdminTarget, so neither of those responses changes.
function requireManageableUser(opts: { allowUnassigned?: boolean } = {}) {
  return asyncHandler(async (req, _res, next) => {
    await assertCanManageUser(req.user!, String(req.params.id), opts);
    next();
  });
}

const permissionOverridesSchema = z.object({
  grants: z.array(z.string()).default([]),
  revokes: z.array(z.string()).default([]),
});

// Access Control (ACL_MANAGE) needs this as a lookup for its principal
// pickers/name-resolvers, same "admin permission shouldn't block a legitimate
// picker use case" rationale as departments.routes.ts's GET / fix.
userRoutes.get("/", requireAnyPermission(PERMISSIONS.USER_MANAGE, PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  // Same skip/take convention as GET /documents. `take` is only parsed (and
  // pagination only applied) when the caller actually passes it — every
  // picker/dropdown consumer that calls this route with no query params keeps
  // getting the full unpaginated list, unchanged.
  const skip = req.query.skip !== undefined ? Number(req.query.skip) : undefined;
  const take = req.query.take !== undefined ? Number(req.query.take) : undefined;
  // `?scope=mine` — same opt-in narrowing as GET /departments, /org-units and
  // /document-types: a DEPT_MANAGER holds USER_MANAGE (it is not an
  // admin-only permission) but should only see/manage the Users admin table
  // for their own department's staff by default, not every employee in the
  // tenant. ACL_BYPASS_ADMIN holders always get the unfiltered list.
  const scoped = req.query.scope === "mine" && !req.user!.permissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN);
  const visibleDepartmentIds = scoped ? await getVisibleDepartmentIds(req.user!.tenantId, req.user!.userId) : undefined;
  const result = await listUsers(req.user!, {
    skip,
    take,
    q: req.query.q ? String(req.query.q) : undefined,
    roleId: req.query.roleId ? String(req.query.roleId) : undefined,
    departmentId: req.query.departmentId ? String(req.query.departmentId) : undefined,
    orgUnitId: req.query.orgUnitId ? String(req.query.orgUnitId) : undefined,
    isActive: req.query.isActive === 'active' || req.query.isActive === 'inactive' ? req.query.isActive : undefined,
    visibleDepartmentIds,
  });
  res.set('Cache-Control', 'private, max-age=30');
  res.json(result);
}));

userRoutes.get("/me", asyncHandler(async (req, res) => {
  res.json(await getMe(req.user!.userId));
}));

// D8c: self-service handwritten-signature image (body: { signatureImage: dataUrl | null }).
userRoutes.put("/me/signature-image", asyncHandler(async (req, res) => {
  res.json(await setSignatureImage(req.user!.userId, req.body?.signatureImage ?? null));
}));

// D10: per-executive opt-out from approved-letter notice emails.
userRoutes.put("/me/exec-notice-opt-out", asyncHandler(async (req, res) => {
  res.json(await setExecNoticeOptOut(req.user!.userId, Boolean(req.body?.optOut)));
}));

// L3: self-service email notification preferences (persisted + honored by the
// outbox EMAIL dispatcher for work-reminder emails; compliance emails ignore).
userRoutes.get("/me/notification-prefs", asyncHandler(async (req, res) => {
  res.json(await getNotificationPrefs(req.user!.userId));
}));

userRoutes.put("/me/notification-prefs", asyncHandler(async (req, res) => {
  res.json(await setNotificationPrefs(req.user!.userId, req.body ?? {}));
}));

userRoutes.post("/", requirePermission(PERMISSIONS.USER_MANAGE), asyncHandler(async (req, res) => {
  res.status(201).json(await createUser(req.body, {
    userId: req.user!.userId,
    tenantId: req.user!.tenantId,
    permissions: req.user!.permissions,
  }));
}));

userRoutes.get("/:id", requireSelfOrPermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), asyncHandler(async (req, res) => {
  // Reading your own profile needs no scope; reading anyone else's is user administration.
  if (String(req.params.id) !== req.user!.userId) await assertCanManageUser(req.user!, String(req.params.id));
  res.json(await getUser(String(req.params.id), req.user!));
}));

userRoutes.get("/:id/activity", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  const data = await getUserActivity(String(req.params.id), req.user!.tenantId, req.user!.userId);
  res.json({ data });
}));

userRoutes.patch("/:id", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  res.json(await updateUser(String(req.params.id), req.body, req.user!.userId));
}));

userRoutes.delete("/:id", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  res.json(await softDeleteUser(String(req.params.id), req.user!.userId));
}));

userRoutes.post("/:id/activate", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  res.json(await activateUser(String(req.params.id), req.user!.userId));
}));

userRoutes.post("/:id/deactivate", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  res.json(await deactivateUser(String(req.params.id), req.user!.userId));
}));

userRoutes.post("/:id/force-logout", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  res.json(await forceLogoutUser(String(req.params.id), req.user!.userId));
}));

userRoutes.post("/:id/roles", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  res.status(201).json(await assignRole(
    String(req.params.id),
    String(req.body.roleId),
    req.user?.userId,
    req.user!.tenantId,
    req.user!.permissions,
  ));
}));

userRoutes.delete("/:id/roles/:roleId", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  await removeRole(String(req.params.id), String(req.params.roleId), req.user?.userId);
  res.status(204).send();
}));

userRoutes.get("/:id/permission-overrides", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  const overrides = await getUserPermissionOverrides(String(req.params.id), req.user!.tenantId);
  res.json({ data: overrides });
}));

userRoutes.put("/:id/permission-overrides", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  const parsed = permissionOverridesSchema.parse(req.body);
  const overrides = await replaceUserPermissionOverrides(
    String(req.params.id),
    req.user!.tenantId,
    parsed.grants,
    parsed.revokes,
    req.user!.userId,
    req.user!.permissions,
  );
  res.json({ data: overrides });
}));

userRoutes.post("/:id/departments", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser({ allowUnassigned: true }), asyncHandler(async (req, res) => {
  // The department itself must be one the caller heads (and exist in their tenant).
  await assertCanManageDepartment(req.user!, String(req.body.departmentId));
  res.status(201).json(await assignDepartment(String(req.params.id), String(req.body.departmentId), req.user!.tenantId, req.user!.userId));
}));

userRoutes.delete("/:id/departments/:deptId", requirePermission(PERMISSIONS.USER_MANAGE), guardPlatformAdminTarget(), requireManageableUser(), asyncHandler(async (req, res) => {
  await assertCanManageDepartment(req.user!, String(req.params.deptId));
  await removeDepartment(String(req.params.id), String(req.params.deptId), req.user!.tenantId, req.user!.userId);
  res.json({ success: true });
}));
