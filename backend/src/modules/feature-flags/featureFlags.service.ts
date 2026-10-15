// Per-tenant feature flags (Documentations/rollout.md §4.2). The point: ship a risky change
// deployed but OFF by default, turn it on for one tenant to verify it, then
// everyone — decoupling "deployed" from "turned on" so you can keep shipping
// without every change being instantly live for every real user.
//
// Flags live in tenants.feature_flags (JSONB, e.g. {"cams_v2_dispatch": true}),
// cached the same way RolePermission is (featureFlagCache.ts) so a hot-path
// check like `isEnabled()` doesn't cost a DB round-trip on every call.

import { z } from 'zod';
import { AppError } from '../../core/AppError.js';
import { Tenant } from '../../infrastructure/database/index.js';
import { runInTransaction } from '../../shared/transaction.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { getCachedFeatureFlags, cacheFeatureFlags, invalidateFeatureFlags } from '../../infrastructure/cache/featureFlagCache.js';

const FLAG_NAME = z.string().min(1).max(100).regex(/^[a-z0-9_]+$/, 'Flag names are lowercase_snake_case');

async function loadFlags(tenantId: string): Promise<Record<string, boolean>> {
  const cached = await getCachedFeatureFlags(tenantId);
  if (cached) return cached;

  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'featureFlags'] });
  if (!tenant) throw new AppError(404, 'ERR-TENANT-NOT-FOUND', 'Tenant not found');

  const flags = tenant.featureFlags ?? {};
  await cacheFeatureFlags(tenantId, flags);
  return flags;
}

/** The one function most call sites need: "is this on for this tenant?" —
 *  defaults to false for anything not explicitly set, so a brand new flag
 *  is off everywhere until someone deliberately turns it on. */
export async function isEnabled(tenantId: string, flagName: string): Promise<boolean> {
  const flags = await loadFlags(tenantId);
  return flags[flagName] === true;
}

export async function getFlags(tenantId: string): Promise<Record<string, boolean>> {
  return loadFlags(tenantId);
}

export async function setFlag(
  tenantId: string,
  flagNameInput: string,
  enabled: boolean,
  updatedBy: { userId: string; role: string },
): Promise<Record<string, boolean>> {
  const flagName = FLAG_NAME.parse(flagNameInput);

  const updated = await runInTransaction(async (tx) => {
    const tenant = await Tenant.findByPk(tenantId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!tenant) throw new AppError(404, 'ERR-TENANT-NOT-FOUND', 'Tenant not found');

    const nextFlags = { ...(tenant.featureFlags ?? {}), [flagName]: enabled };
    await tenant.update({ featureFlags: nextFlags }, { transaction: tx });

    // Only clear the cache after the transaction actually commits — clearing
    // it eagerly here would let a concurrent reader repopulate the cache
    // from a pre-commit read if this transaction later rolled back.
    tx.afterCommit(() => {
      void invalidateFeatureFlags(tenantId);
    });

    return nextFlags;
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.FEATURE_FLAG_UPDATED,
    userId: updatedBy.userId,
    userRole: updatedBy.role,
    tenantId,
    actionDetails: { tenantId, flagName, enabled },
  });

  return updated;
}
