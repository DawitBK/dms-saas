import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { requirePermission } from "../../shared/auth.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { documentStates } from "./DocumentStateMachine.js";
import {
  listStatusPermissionRules,
  setStatusPermissionRoles,
  STATUS_GATED_ACTIONS,
} from "./statusPermissions.service.js";

export const statusPermissionsRoutes = Router();

const setRuleSchema = z.object({
  status: z.string().min(1).max(50),
  action: z.string().min(1).max(50),
  roleNames: z.array(z.string()),
});

// Single source of truth for the admin UI's Status/Action pickers — the
// frontend fetches this instead of hardcoding a second copy of
// documentStates / STATUS_GATED_ACTIONS that could drift out of sync.
statusPermissionsRoutes.get(
  "/metadata",
  requirePermission(PERMISSIONS.ACL_MANAGE),
  asyncHandler(async (_req, res) => {
    res.json({ data: { statuses: documentStates, actions: STATUS_GATED_ACTIONS } });
  }),
);

statusPermissionsRoutes.get(
  "/",
  requirePermission(PERMISSIONS.ACL_MANAGE),
  asyncHandler(async (req, res) => {
    const rules = await listStatusPermissionRules(req.user!.tenantId);
    res.json({ data: rules });
  }),
);

// Upserts (or, with an empty roleNames array, clears) the rule for one
// (status, action) tuple. Same gate as the rest of the Access Control panel.
statusPermissionsRoutes.put(
  "/",
  requirePermission(PERMISSIONS.ACL_MANAGE),
  asyncHandler(async (req, res) => {
    const parsed = setRuleSchema.parse(req.body);
    const rule = await setStatusPermissionRoles(
      req.user!.tenantId,
      parsed.status,
      parsed.action,
      parsed.roleNames,
      { userId: req.user!.userId, role: req.user!.role },
    );
    res.json({ data: rule });
  }),
);
