// §2: Tenant CRUD routes — gated by tenant:read / tenant:manage permissions.
import { excludeHiddenWhere, hiddenUserIds, isHiddenUser } from "../../shared/platformAdmin.js";
import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { OPERATION_TENANT_CREATE, requireOwnerAuthorisation } from "../auth/ownerAuthorisation.js";
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS } from "../../config/permissions.js";
import {
  createTenant,
  deactivateTenant,
  getTenant,
  listTenants,
  updateTenant
} from "./tenants.service.js";

export const tenantRoutes = Router();

// SECURITY FIX: none of these :id routes previously checked req.params.id
// against the caller's own tenantId — tenant:manage is part of SYSTEM_ADMIN's
// blanket default grant (ROLE_PERMISSIONS.SYSTEM_ADMIN = every permission),
// so ANY tenant's own SYSTEM_ADMIN could read/edit/deactivate ANY OTHER
// tenant, or add themselves (or anyone) as a member of it — then use the
// existing two-phase select-tenant login flow to obtain a real access token
// scoped to that other tenant. Full cross-tenant account/data compromise,
// the same "trust the client-supplied id over the JWT's own tenant claim"
// shape already fixed once for feature-flags. Scoped here to "manage your
// own tenant" (list/read/update/deactivate/exec-notice/members), matching
// every other tenant-scoped resource in this codebase.
//
// FIX 2026-09-14: a genuine platform:admin holder (see permissions.ts —
// deliberately never granted alongside plain SYSTEM_ADMIN) is EXEMPT from
// this check by design, not a bypass of it: they operate the platform
// itself, not one tenant, so "your own tenant" doesn't apply to them the way
// it does to every tenant-scoped role. This is the same permission that
// gates POST / below and the switchTenant membership check in
// auth.service.ts — holding it means full cross-tenant reach everywhere a
// tenant's own admin is scoped to just their tenant.
function assertOwnTenant(req: { user?: { tenantId: string; permissions?: readonly string[] } }, tenantId: string) {
  if (req.user!.permissions?.includes(PERMISSIONS.PLATFORM_ADMIN)) return;
  if (req.user!.tenantId !== tenantId) {
    throw new AppError(404, "ERR-TENANT-NOT-FOUND", "Tenant not found");
  }
}

tenantRoutes.get("/", requirePermission(PERMISSIONS.TENANT_READ), asyncHandler(async (req, res) => {
  const isPlatformAdmin = Boolean(req.user!.permissions?.includes(PERMISSIONS.PLATFORM_ADMIN));
  const data = await listTenants(req.user!.tenantId, req.user!.userId, isPlatformAdmin);
  res.json({ data });
}));
// FIX 2026-09-14: creating a brand-new tenant is a platform operation, not a
// "manage my own tenant" one — see permissions.ts's PLATFORM_ADMIN comment.
// Previously gated on tenant:manage, which every tenant's own SYSTEM_ADMIN
// holds, so any customer's admin could spin up an unrelated tenant for a
// different company. Only platform:admin holders can create tenants now.
// 2026-10-19: and, when OWNER_VERIFICATION_REQUIRED is on (production and mirror by default), only with a single-use
// owner ticket issued by SSO for "dms.tenant.create" (X-Owner-Authorisation header): a stolen platform-admin session is
// not enough. PATCH/DELETE on a tenant stay tenant:manage (a tenant's own admin) and are deliberately not owner-only.
tenantRoutes.post("/", requirePermission(PERMISSIONS.PLATFORM_ADMIN), requireOwnerAuthorisation(OPERATION_TENANT_CREATE), asyncHandler(async (req, res) =>
  res.status(201).json({ data: await createTenant(req.body, req.user!.userId) })
));
tenantRoutes.get("/:id", requirePermission(PERMISSIONS.TENANT_READ), asyncHandler(async (req, res) => {
  assertOwnTenant(req, String(req.params.id));
  res.json({ data: await getTenant(String(req.params.id)) });
}));
tenantRoutes.patch("/:id", requirePermission(PERMISSIONS.TENANT_MANAGE), asyncHandler(async (req, res) => {
  assertOwnTenant(req, String(req.params.id));
  res.json({ data: await updateTenant(String(req.params.id), req.body, req.user!.userId) });
}));
tenantRoutes.delete("/:id", requirePermission(PERMISSIONS.TENANT_MANAGE), asyncHandler(async (req, res) => {
  assertOwnTenant(req, String(req.params.id));
  res.json({ data: await deactivateTenant(String(req.params.id), req.user!.userId) });
}));

// D10: executive-notice policy — which letter types auto-email executives and
// up to which confidentiality ({ letterTypes?: string[], maxConfidentiality?:
// 'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED' }). CONFIDENTIAL/RESTRICTED
// stay excluded unless explicitly raised here.
tenantRoutes.put("/:id/exec-notice-config", requirePermission(PERMISSIONS.TENANT_MANAGE), asyncHandler(async (req, res) => {
  assertOwnTenant(req, String(req.params.id));
  const { Tenant } = await import("../../infrastructure/database/index.js");
  const tenant = await Tenant.findByPk(String(req.params.id));
  if (!tenant) return res.status(404).json({ error: { code: "ERR-TENANT-NOT-FOUND", message: "Tenant not found" } });
  const body = (req.body ?? {}) as { letterTypes?: unknown; maxConfidentiality?: unknown };
  const letterTypes = Array.isArray(body.letterTypes)
    ? body.letterTypes.filter((t): t is string => typeof t === "string" && ["OUT", "IN", "MEMO", "CIRC", "CONT"].includes(t))
    : undefined;
  const maxConfidentiality =
    typeof body.maxConfidentiality === "string" &&
    ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"].includes(body.maxConfidentiality)
      ? body.maxConfidentiality
      : undefined;
  const execNoticeConfig = {
    ...(letterTypes !== undefined ? { letterTypes } : {}),
    ...(maxConfidentiality !== undefined ? { maxConfidentiality } : {}),
  };
  await tenant.update({ execNoticeConfig });
  return res.json({ data: { execNoticeConfig } });
}));

// Tenant membership management (mirrors /users/:id/roles pattern)
tenantRoutes.get("/:id/members", requirePermission(PERMISSIONS.TENANT_MANAGE), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  assertOwnTenant(req, tenantId);
  const { UserTenant, User } = await import("../../infrastructure/database/index.js");
  
  const hidden = await hiddenUserIds(req.user!.userId);
  const members = await UserTenant.findAll({
    where: { tenantId, ...excludeHiddenWhere(hidden, 'userId') },
    include: [{
      model: User,
      as: 'user',
      attributes: ['id', 'email', 'firstName', 'lastName', 'isActive']
    }],
    order: [['assignedAt', 'DESC']]
  });
  
  res.json({ data: members });
}));

tenantRoutes.post("/:id/members", requirePermission(PERMISSIONS.TENANT_MANAGE), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  assertOwnTenant(req, tenantId);
  const { userId } = req.body as { userId: string };
  
  if (!userId) {
    const { AppError } = await import("../../core/AppError.js");
    throw new AppError(400, "ERR-INVALID-INPUT", "userId is required");
  }
  
  const { UserTenant, User, Tenant } = await import("../../infrastructure/database/index.js");
  
  // Verify tenant exists
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) {
    const { AppError } = await import("../../core/AppError.js");
    throw new AppError(404, "ERR-TENANT-NOT-FOUND", "Tenant not found");
  }
  
  // Verify user exists (a platform admin reads as nonexistent)
  const user = (await isHiddenUser(userId, req.user!.userId)) ? null : await User.findByPk(userId);
  if (!user || !user.isActive) {
    const { AppError } = await import("../../core/AppError.js");
    throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found or inactive");
  }
  
  // Check if membership already exists
  const existing = await UserTenant.findOne({
    where: { userId, tenantId }
  });
  
  if (existing) {
    const { AppError } = await import("../../core/AppError.js");
    throw new AppError(409, "ERR-ALREADY-EXISTS", "User is already a member of this tenant");
  }
  
  // Create membership
  const membership = await UserTenant.create({
    userId,
    tenantId,
    assignedBy: req.user!.userId,
    assignedAt: new Date()
  });
  
  res.status(201).json({ data: membership });
}));

tenantRoutes.delete("/:id/members/:userId", requirePermission(PERMISSIONS.TENANT_MANAGE), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  assertOwnTenant(req, tenantId);
  const userId = String(req.params.userId);

  const { UserTenant } = await import("../../infrastructure/database/index.js");
  
  const membership = (await isHiddenUser(userId, req.user!.userId)) ? null : await UserTenant.findOne({
    where: { userId, tenantId }
  });
  
  if (!membership) {
    const { AppError } = await import("../../core/AppError.js");
    throw new AppError(404, "ERR-NOT-FOUND", "Membership not found");
  }
  
  await membership.destroy();
  
  res.status(204).send();
}));
