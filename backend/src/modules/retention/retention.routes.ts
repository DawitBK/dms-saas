import { Router } from "express";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import {
  createRetentionPolicy,
  deactivateRetentionPolicy,
  getRetentionPolicy,
  listRetentionPolicies,
  updateRetentionPolicy,
  authoriseDisposal,
  restoreFromCold
} from "./retention.service.js";

export const retentionRoutes = Router();

retentionRoutes.post("/cold-restore/:documentId", requirePermission(PERMISSIONS.RETENTION_MANAGE), asyncHandler(async (req, res) => {
  res.json({ data: await restoreFromCold(String(req.params.documentId), req.user!.userId, req.user!.tenantId) });
}));

retentionRoutes.get("/", requirePermission(PERMISSIONS.RETENTION_READ), asyncHandler(async (_req, res) => {
  const data = await listRetentionPolicies();
  res.json({ data });
}));

retentionRoutes.post("/", requirePermission(PERMISSIONS.RETENTION_MANAGE), asyncHandler(async (req, res) => {
  res.status(201).json({ data: await createRetentionPolicy(req.body, req.user!.userId) });
}));

retentionRoutes.post("/disposal/:documentId/authorise", requirePermission(PERMISSIONS.RETENTION_MANAGE), asyncHandler(async (req, res) => {
  res.json({ data: await authoriseDisposal(String(req.params.documentId), req.user!.userId, req.user!.tenantId) });
}));

// Platform audit finding (2026-08-14, HIGH): these three routes used
// requireACL({resourceType:'retention', ...}), but nothing ever writes an
// AclEntry row for that resourceType, so resolveACL's deny-by-default 403'd
// (AUTHZ_ACL_NO_ENTRY) every role except SYSTEM_ADMIN — including
// RECORDS_OFFICER, explicitly granted RETENTION_MANAGE and clearly meant to
// administer these. Retention policies aren't a per-instance-ACL'd resource
// at all — RetentionPolicy has no tenantId column even (genuinely shared,
// platform-wide config, unlike legal holds) — so RBAC alone
// (requirePermission, already present) is the correct and complete gate.
retentionRoutes.get("/:id", requirePermission(PERMISSIONS.RETENTION_READ), asyncHandler(async (req, res) => {
  res.json({ data: await getRetentionPolicy(String(req.params.id)) });
}));

retentionRoutes.patch("/:id", requirePermission(PERMISSIONS.RETENTION_MANAGE), asyncHandler(async (req, res) => {
  res.json({ data: await updateRetentionPolicy(String(req.params.id), req.body, req.user!.userId) });
}));

retentionRoutes.delete("/:id", requirePermission(PERMISSIONS.RETENTION_MANAGE), asyncHandler(async (req, res) => {
  res.json({ data: await deactivateRetentionPolicy(String(req.params.id), req.user!.userId) });
}));
