// SPRINT-3 (S3-07): ACL Management Routes
// POST/GET/DELETE endpoints for ACL entries

import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import {
  createAclEntry,
  listAclEntries,
  getAclEntry,
  deleteAclEntry,
  deleteAclEntriesForPrincipal,
  listAclEntriesByPrincipal,
  createBulkAclEntries
} from "./acl.service.js";
import type { AclResourceType } from "../../shared/resolveACL.js";

export const aclRoutes = Router();

/**
 * POST /api/v1/acl/:resourceType/:resourceId
 * Create a new ACL entry for a resource
 * Required: ACL_MANAGE permission + ACL write permission on resource
 */
aclRoutes.post("/:resourceType/:resourceId", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const resourceType = String(req.params.resourceType) as AclResourceType;
  const resourceId = String(req.params.resourceId);
  const user = req.user!;

  const entry = await createAclEntry(resourceType, resourceId, req.body, user.userId, user.tenantId);

  res.status(201).json({
    data: {
      id: entry.id,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      principalType: entry.principalType,
      principalId: entry.principalId,
      effect: entry.effect,
      permission: entry.permission,
      expiresAt: entry.expiresAt,
      createdAt: entry.createdAt
    }
  });
}));

/**
 * GET /api/v1/acl/:resourceType/:resourceId
 * List all ACL entries for a resource
 * Required: ACL_MANAGE permission
 */
aclRoutes.get("/:resourceType/:resourceId", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const resourceType = String(req.params.resourceType) as AclResourceType;
  const resourceId = String(req.params.resourceId);
  const tenantId = req.user!.tenantId;

  const entries = await listAclEntries(resourceType, resourceId, tenantId);

  res.json({
    data: entries.map(e => ({
      id: e.id,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      principalType: e.principalType,
      principalId: e.principalId,
      effect: e.effect,
      permission: e.permission,
      expiresAt: e.expiresAt,
      grantedById: e.grantedById,
      granter: (e as unknown as { granter?: { id: string; firstName: string; lastName: string; email: string } | null }).granter ?? null,
      createdAt: e.createdAt
    }))
  });
}));

/**
 * GET /api/v1/acl/:aclId
 * Get a single ACL entry by ID
 * Required: ACL_MANAGE permission
 */
aclRoutes.get("/:aclId", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const aclId = String(req.params.aclId);
  const tenantId = req.user!.tenantId;

  const entry = await getAclEntry(aclId, tenantId);

  res.json({
    data: {
      id: entry.id,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      principalType: entry.principalType,
      principalId: entry.principalId,
      effect: entry.effect,
      permission: entry.permission,
      expiresAt: entry.expiresAt,
      grantedById: entry.grantedById,
      granter: (entry as unknown as { granter?: { id: string; firstName: string; lastName: string; email: string } | null }).granter ?? null,
      createdAt: entry.createdAt
    }
  });
}));

/**
 * DELETE /api/v1/acl/:aclId
 * Delete an ACL entry by ID
 * Required: ACL_MANAGE permission
 */
aclRoutes.delete("/:aclId", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const aclId = String(req.params.aclId);
  const tenantId = req.user!.tenantId;

  await deleteAclEntry(aclId, tenantId, req.user!.userId);

  res.json({ message: "ACL entry deleted" });
}));

/**
 * DELETE /api/v1/acl/:resourceType/:resourceId/:principalType/:principalId
 * Delete all ACL entries for a principal on a resource
 * Required: ACL_MANAGE permission
 */
aclRoutes.delete(
  "/:resourceType/:resourceId/:principalType/:principalId",
  requirePermission(PERMISSIONS.ACL_MANAGE),
  asyncHandler(async (req, res) => {
    const resourceType = String(req.params.resourceType) as AclResourceType;
    const resourceId = String(req.params.resourceId);
    const principalType = String(req.params.principalType) as "user" | "role";
    const principalId = String(req.params.principalId);
    const tenantId = req.user!.tenantId;

    if (principalType !== "user" && principalType !== "role") {
      res.status(400).json({ error: { code: "ERR-INVALID-PRINCIPAL", message: "principalType must be 'user' or 'role'" } });
      return;
    }

    const count = await deleteAclEntriesForPrincipal(resourceType, resourceId, principalType, principalId, tenantId, req.user!.userId);

    res.json({ message: `Deleted ${count} ACL entries` });
  })
);

/**
 * GET /api/v1/acl?principalType=<user|role>&principalId=<id>
 * List all ACL entries for a specific principal across all resources
 * Required: ACL_MANAGE permission
 */
aclRoutes.get("/", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const principalType = String(req.query.principalType) as "user" | "role";
  const principalId = String(req.query.principalId);
  const tenantId = req.user!.tenantId;

  if (!principalType || !principalId) {
    res.status(400).json({ error: { code: "ERR-MISSING-PARAMS", message: "principalType and principalId are required" } });
    return;
  }

  if (principalType !== "user" && principalType !== "role") {
    res.status(400).json({ error: { code: "ERR-INVALID-PRINCIPAL", message: "principalType must be 'user' or 'role'" } });
    return;
  }

  const entries = await listAclEntriesByPrincipal(principalType, principalId, tenantId);

  res.json({
    data: entries.map(entry => ({
      id: entry.id,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      principalType: entry.principalType,
      principalId: entry.principalId,
      effect: entry.effect,
      permission: entry.permission,
      expiresAt: entry.expiresAt,
      grantedById: entry.grantedById,
      granter: (entry as unknown as { granter?: { id: string; firstName: string; lastName: string; email: string } | null }).granter ?? null,
      createdAt: entry.createdAt
    }))
  });
}));

/**
 * POST /api/v1/acl/:resourceType/:resourceId/bulk
 * Create multiple ACL entries for a resource in bulk
 * Required: ACL_MANAGE permission
 */
aclRoutes.post("/:resourceType/:resourceId/bulk", requirePermission(PERMISSIONS.ACL_MANAGE), asyncHandler(async (req, res) => {
  const resourceType = String(req.params.resourceType) as AclResourceType;
  const resourceId = String(req.params.resourceId);
  const user = req.user!;

  const entries = await createBulkAclEntries(resourceType, resourceId, req.body, user.userId, user.tenantId);

  res.status(201).json({
    data: entries.map(entry => ({
      id: entry.id,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      principalType: entry.principalType,
      principalId: entry.principalId,
      effect: entry.effect,
      permission: entry.permission,
      expiresAt: entry.expiresAt,
      grantedById: entry.grantedById,
      createdAt: entry.createdAt
    }))
  });
}));
