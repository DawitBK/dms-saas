import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission, requireAnyPermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { Role } from "../../infrastructure/database/index.js";
import { isPlatformAdminRoleName, withoutPlatformAdminRole } from "../../shared/platformAdmin.js";
import { AppError } from "../../core/AppError.js";
import {
  getRolePermissionsByRoleId,
  replaceRolePermissions,
  listIdpRoleMappings,
  isBuiltInRoleName,
  updateCustomRoleDescription,
  deleteCustomRole
} from "./roles.service.js";

export const rolesRoutes = Router();

// Editing what a ROLE means (creating a role, replacing a role's permission set)
// changes it for every holder in the tenant — it is tenant-wide administration,
// not "manage the people in my department". role:manage alone is not enough:
// the C1 guard only limits what can be ADDED, so a department manager holding
// role:manage could strip permissions from SYSTEM_ADMIN's role or widen
// EMPLOYEE for the whole tenant up to their own set. Role definitions are
// therefore reserved to tenant-wide authority (acl:bypass_admin); a department
// manager changes an individual member through role ASSIGNMENT and per-user
// permission overrides (users.routes.ts), which are scoped to their department.
function requireTenantWideRoleAuthority() {
  return asyncHandler(async (req, _res, next) => {
    if (!req.user!.permissions.includes(PERMISSIONS.ACL_BYPASS_ADMIN)) {
      throw new AppError(403, "ERR-ROLE-DEFINITION-RESERVED", "Only an organisation administrator can change role definitions");
    }
    next();
  });
}

const createRoleSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, "Role name must be uppercase letters, digits, and underscores only"),
  description: z.string().max(255).optional(),
});

const rolePermissionsSchema = z.object({
  permissions: z.array(z.string())
});

// Access Control (ACL_MANAGE) needs this as a lookup for its role picker —
// same "admin permission shouldn't block a legitimate picker use case"
// rationale as departments.routes.ts's GET / fix.
rolesRoutes.get("/", requireAnyPermission(PERMISSIONS.ROLE_READ, PERMISSIONS.ACL_MANAGE), asyncHandler(async (_req, res) => {
  const roles = await Role.findAll({ order: [['name', 'ASC']] });
  // The platform-admin role is never offered for selection, display or editing.
  // isBuiltIn lets the screen offer Edit/Delete only for custom roles.
  res.json({ data: withoutPlatformAdminRole(roles).map((r) => ({ ...(r.toJSON?.() ?? r), isBuiltIn: isBuiltInRoleName(String(r.name)) })) });
}));

// Create a custom role at runtime (ROLE_MANAGE permission required).
// Built-in roles (SYSTEM_ADMIN, RECORDS_OFFICER, etc.) are seeded; this endpoint
// is for tenant-specific custom roles.
rolesRoutes.post("/", requirePermission(PERMISSIONS.ROLE_MANAGE), requireTenantWideRoleAuthority(), asyncHandler(async (req, res) => {
  const parsed = createRoleSchema.parse(req.body);
  const existing = await Role.findOne({ where: { name: parsed.name } });
  // Do not reveal that the reserved name exists, and never let a "custom" role shadow it.
  if (existing || isPlatformAdminRoleName(parsed.name)) {
    res.status(409).json({ error: { code: "ERR-ROLE-EXISTS", message: `Role '${parsed.name}' already exists` } });
    return;
  }
  const role = await Role.create({ name: parsed.name, description: parsed.description ?? null } as any);
  res.status(201).json({ data: { roleId: role.id, roleName: role.name } });
}));

// Change a custom role's description (the name is fixed on purpose: recipes, steps and SSO mappings refer to it by name).
rolesRoutes.patch("/:id", requirePermission(PERMISSIONS.ROLE_MANAGE), requireTenantWideRoleAuthority(), asyncHandler(async (req, res) => {
  const parsed = z.object({ description: z.string().max(255).nullable() }).parse(req.body);
  const role = await updateCustomRoleDescription(String(req.params.id), parsed.description?.trim() || null, req.user!);
  res.json({ data: { roleId: role.id, roleName: role.name, description: role.description } });
}));

// Delete a custom role. Refused with a specific reason while anyone or anything still uses it.
rolesRoutes.delete("/:id", requirePermission(PERMISSIONS.ROLE_MANAGE), requireTenantWideRoleAuthority(), asyncHandler(async (req, res) => {
  res.json({ data: await deleteCustomRole(String(req.params.id), req.user!) });
}));

rolesRoutes.get("/:id/permissions", requirePermission(PERMISSIONS.ROLE_READ), asyncHandler(async (req, res) => {
  const role = await Role.findByPk(String(req.params.id), { attributes: ["id", "name"] });
  if (!role || isPlatformAdminRoleName(role.name)) {
    res.status(404).json({ error: { code: "ERR-ROLE-NOT-FOUND", message: "Role not found" } });
    return;
  }

  const permissions = await getRolePermissionsByRoleId(role.id, req.user!.tenantId, role.name);
  res.json({
    data: {
      roleId: role.id,
      roleName: role.name,
      permissions
    }
  });
}));

// Read-only visibility into the AD-group -> role mapping table SSO's own
// admin console writes (roles/internal.routes.ts) — see listIdpRoleMappings's
// comment. Platform-admin-only per the "visible only to him" instruction this
// was built for; writes still happen exclusively from the SSO console.
rolesRoutes.get("/idp-mappings", requirePermission(PERMISSIONS.PLATFORM_ADMIN), asyncHandler(async (_req, res) => {
  res.json({ data: await listIdpRoleMappings() });
}));

rolesRoutes.put("/:id/permissions", requirePermission(PERMISSIONS.ROLE_MANAGE), requireTenantWideRoleAuthority(), asyncHandler(async (req, res) => {
  const parsed = rolePermissionsSchema.parse(req.body);
  const permissions = await replaceRolePermissions(
    String(req.params.id),
    req.user!.tenantId,
    parsed.permissions,
    req.user!.userId,
    req.user!.permissions,
  );

  res.json({
    data: {
      roleId: String(req.params.id),
      permissions
    }
  });
}));
