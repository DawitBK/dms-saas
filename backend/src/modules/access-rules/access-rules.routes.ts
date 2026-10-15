import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import {
  createAccessRules,
  listAccessRules,
  getAccessRule,
  deleteAccessRule
} from "./access-rules.service.js";

export const accessRulesRoutes = Router();

/**
 * POST /api/v1/access-rules
 * Create one or more access rules (tenant-wide or document-type-wide) for
 * the same principal/effect/scope — one row per permission, all-or-nothing.
 * Accepts either `permissions: string[]` or a single `permission: string`
 * (back-compat with any existing caller sending the old singular field).
 * Required: ACL_MANAGE permission
 */
accessRulesRoutes.post("/", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const user = req.user!;
  const permissions: string[] = Array.isArray(req.body.permissions)
    ? req.body.permissions
    : req.body.permission
      ? [req.body.permission]
      : [];
  const rules = await createAccessRules({ ...req.body, permissions }, user.userId, user.tenantId);

  res.status(201).json({
    data: rules.map(rule => ({
      id: rule.id,
      principalType: rule.principalType,
      principalId: rule.principalId,
      effect: rule.effect,
      permission: rule.permission,
      documentTypeId: rule.documentTypeId,
      expiresAt: rule.expiresAt,
      grantedById: rule.grantedById,
      createdAt: rule.createdAt
    }))
  });
}));

/**
 * GET /api/v1/access-rules
 * List all access rules, optionally filtered by principal or document type
 * Required: ACL_MANAGE permission
 */
accessRulesRoutes.get("/", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const tenantId = req.user!.tenantId;
  
  const filters: any = {};
  if (req.query.principalType) {
    filters.principalType = String(req.query.principalType) as "user" | "role";
  }
  if (req.query.principalId) {
    filters.principalId = String(req.query.principalId);
  }
  if (req.query.documentTypeId !== undefined) {
    filters.documentTypeId = req.query.documentTypeId === "null" ? null : String(req.query.documentTypeId);
  }

  const rules = await listAccessRules(tenantId, filters);

  res.json({
    data: rules.map(rule => ({
      id: rule.id,
      principalType: rule.principalType,
      principalId: rule.principalId,
      effect: rule.effect,
      permission: rule.permission,
      documentTypeId: rule.documentTypeId,
      expiresAt: rule.expiresAt,
      grantedById: rule.grantedById,
      granter: (rule as unknown as { granter?: { id: string; firstName: string; lastName: string; email: string } | null }).granter ?? null,
      createdAt: rule.createdAt
    }))
  });
}));

/**
 * GET /api/v1/access-rules/:id
 * Get a single access rule by ID
 * Required: ACL_MANAGE permission
 */
accessRulesRoutes.get("/:id", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const ruleId = String(req.params.id);
  const tenantId = req.user!.tenantId;

  const rule = await getAccessRule(ruleId, tenantId);

  res.json({
    data: {
      id: rule.id,
      principalType: rule.principalType,
      principalId: rule.principalId,
      effect: rule.effect,
      permission: rule.permission,
      documentTypeId: rule.documentTypeId,
      expiresAt: rule.expiresAt,
      grantedById: rule.grantedById,
      granter: (rule as unknown as { granter?: { id: string; firstName: string; lastName: string; email: string } | null }).granter ?? null,
      createdAt: rule.createdAt
    }
  });
}));

/**
 * DELETE /api/v1/access-rules/:id
 * Delete an access rule by ID
 * Required: ACL_MANAGE permission
 */
accessRulesRoutes.delete("/:id", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const ruleId = String(req.params.id);
  const tenantId = req.user!.tenantId;

  await deleteAccessRule(ruleId, tenantId, req.user!.userId);

  res.json({ message: "Access rule deleted" });
}));
