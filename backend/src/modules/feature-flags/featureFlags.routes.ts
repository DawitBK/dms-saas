import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { requirePermission } from '../../shared/auth.js';
import { AppError } from '../../core/AppError.js';
import { PERMISSIONS } from '../../config/permissions.js';
import { getFlags, setFlag } from './featureFlags.service.js';

export const featureFlagsRoutes = Router();

const setFlagSchema = z.object({
  flag: z.string().min(1).max(100),
  enabled: z.boolean(),
});

// tenant:manage is a per-tenant assignable permission (see roles.service.ts's
// privilege-escalation guard) — a tenant's own custom role can hold it to
// manage THAT tenant, same as tenant quota/settings management. Unlike every
// other :tenantId-parameterized route, these two never checked the URL's
// tenantId against the caller's own JWT tenantId, so any tenant-manage holder
// could read/flip another tenant's flags by guessing/enumerating its id
// (audit 2026-07-26 #5).
function assertOwnTenant(req: { user?: { tenantId: string } }, tenantId: string) {
  if (req.user!.tenantId !== tenantId) {
    throw new AppError(403, 'ERR-CROSS-TENANT-FORBIDDEN', 'Cannot manage another tenant\'s feature flags');
  }
}

featureFlagsRoutes.get(
  '/tenants/:tenantId/feature-flags',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  asyncHandler(async (req, res) => {
    const tenantId = String(req.params.tenantId);
    assertOwnTenant(req, tenantId);
    const flags = await getFlags(tenantId);
    res.json({ data: flags });
  }),
);

featureFlagsRoutes.patch(
  '/tenants/:tenantId/feature-flags',
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  asyncHandler(async (req, res) => {
    const tenantId = String(req.params.tenantId);
    assertOwnTenant(req, tenantId);
    const { flag, enabled } = setFlagSchema.parse(req.body);
    const flags = await setFlag(tenantId, flag, enabled, {
      userId: req.user!.userId,
      role: req.user!.role,
    });
    res.json({ data: flags });
  }),
);
