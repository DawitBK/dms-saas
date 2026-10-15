import { randomUUID } from "crypto";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { AccessRule, User } from "../../infrastructure/database/models/index.js";
import { runInTransaction } from "../../shared/transaction.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { invalidateTenantACL } from "../../infrastructure/cache/aclCache.js";

export interface CreateAccessRulesRequest {
  principalType: "user" | "role";
  principalId: string;
  effect: "ALLOW" | "DENY";
  permissions: string[];
  documentTypeId?: string | null;
  expiresAt?: string | null;
}

/**
 * Create one access rule per requested permission (tenant-wide or
 * document-type-wide), atomically — all rows commit together or none do.
 *
 * One AccessRule row is inherently single-permission (that's the table's
 * actual shape), unlike folder/department/document ACL grants which already
 * have a real bulk endpoint. This used to only ever create the FIRST
 * selected permission (`permissions[0], // For now, one at a time`) and
 * silently drop the rest — an admin checking 3 boxes for a tenant-wide grant
 * got a success toast but only 1 of the 3 actually applied. Looping here,
 * inside one transaction, is the permanent fix: every selected permission is
 * granted, or none are if anything fails partway through.
 */
export async function createAccessRules(
  data: CreateAccessRulesRequest,
  grantedById: string,
  tenantId: string
): Promise<AccessRule[]> {
  // Validate input
  if (!data.principalId || !data.permissions?.length) {
    throw new AppError(400, "ERR-INVALID-INPUT", "Missing required fields");
  }

  if (data.effect !== "ALLOW" && data.effect !== "DENY") {
    throw new AppError(400, "ERR-INVALID-EFFECT", "Effect must be ALLOW or DENY");
  }

  // Parse and validate expiresAt
  let expiresAt: Date | null = null;
  if (data.expiresAt) {
    const parsed = new Date(data.expiresAt);
    if (isNaN(parsed.getTime())) {
      throw new AppError(400, "ERR-INVALID-DATE", "Invalid expiresAt date");
    }
    if (parsed <= new Date()) {
      throw new AppError(400, "ERR-EXPIRED-DATE", "expiresAt must be in the future");
    }
    expiresAt = parsed;
  }

  const permissions = Array.from(new Set(data.permissions));

  try {
    // runInTransaction, NOT a bare sequelize.transaction(): this route always
    // runs inside a request, so this reuses the request's already-open,
    // already tenant-GUC'd transaction (tenantContext middleware) instead of
    // opening a second connection with no `app.current_tenant` set — which
    // access_rules' own RLS policy depends on (see
    // 20260710000001-rls-remaining-tenant-tables.sql). A bare
    // sequelize.transaction() here would be silent today (superuser bypasses
    // RLS) and break tenant isolation the day the DB role is restricted —
    // exactly the failure mode runInTransaction's own doc comment describes.
    const documentTypeId = data.documentTypeId || null;

    const rules = await runInTransaction(async (tx) => {
      const created: AccessRule[] = [];
      for (const permission of permissions) {
        // FIX (Finding 3): this used to be a blind AccessRule.create() with no
        // existence check — POSTing a rule over a tuple
        // (tenant, principal, permission, doc-type scope) that already had a
        // rule left the old, now-contradictory row in place under a different
        // id (e.g. a stale DENY silently and permanently outliving a later
        // ALLOW, since resolveACL.ts sorts DENY before ALLOW). Find the
        // existing row for this exact tuple first — locked FOR UPDATE so two
        // concurrent requests for the same tuple can't both see "no existing
        // row" and both insert — and update it in place instead of creating a
        // duplicate; only create when no row for the tuple exists yet.
        const existing = await AccessRule.findOne({
          where: {
            tenantId,
            principalType: data.principalType,
            principalId: data.principalId,
            permission,
            documentTypeId,
          },
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });

        let rule: AccessRule;
        let wasUpdate: boolean;
        if (existing) {
          existing.set({
            effect: data.effect,
            expiresAt,
            grantedById,
            updatedAt: new Date(),
          });
          rule = await existing.save({ transaction: tx });
          wasUpdate = true;
        } else {
          rule = await AccessRule.create(
            {
              id: randomUUID(),
              tenantId,
              principalType: data.principalType,
              principalId: data.principalId,
              effect: data.effect,
              permission,
              documentTypeId,
              expiresAt,
              grantedById,
              createdAt: new Date(),
              updatedAt: new Date()
            },
            { transaction: tx }
          );
          wasUpdate = false;
        }
        created.push(rule);

        // Security-critical: awaited so the audit row is atomic with the
        // rule change (fails the whole grant on audit failure).
        await writeAuditLog({
          eventType: wasUpdate ? AUDIT_EVENTS.ACCESS_RULE_UPDATED : AUDIT_EVENTS.ACCESS_RULE_CREATED,
          userId: grantedById,
          tenantId,
          actionDetails: { ruleId: rule.id, principalType: data.principalType, principalId: data.principalId, effect: data.effect, permission, documentTypeId, tenantId, replacedExistingRule: wasUpdate },
        });
      }

      // FIX: access rules are tenant-wide or doc-type-scoped grants folded
      // into every resolveACL() call, but creating/deleting one never
      // invalidated anything — a newly-added ALLOW left users cached at their
      // prior deny-by-default for up to the cache's full TTL (and the mirror
      // case for DENY). There's no single resourceId to target here, so
      // invalidate tenant-wide. One shot for the whole batch, not per-rule.
      //
      // tx.afterCommit, NOT called after runInTransaction() returns: this tx
      // is the request's own ambient transaction (per runInTransaction above),
      // which doesn't actually commit until the request finishes — calling
      // invalidateTenantACL right after the callback returns would clear the
      // cache while the rows are still uncommitted, letting a concurrent
      // request miss cache, read the DB under READ COMMITTED (still not
      // seeing the new rows), and re-cache the stale pre-grant resolution
      // with a fresh TTL — reintroducing the exact bug this invalidation call
      // exists to fix, just via a timing race instead of a missing call.
      tx.afterCommit(() => {
        void invalidateTenantACL(tenantId).catch((err) => {
          logger.warn({ err, tenantId }, "Failed to invalidate tenant ACL cache after access-rule creation commit");
        });
      });

      return created;
    });

    logger.info(
      {
        ruleIds: rules.map((r) => r.id),
        principalType: data.principalType,
        principalId: data.principalId,
        documentTypeId: data.documentTypeId,
        effect: data.effect,
        permissions
      },
      "Access rules created"
    );

    return rules;
  } catch (error) {
    // Only add context and rethrow -- a malformed id (Postgres 22P02), a
    // pool-capacity timeout, or a real constraint violation are all now
    // classified precisely by errorHandler's central dispatch (dbErrors.ts);
    // wrapping them here as a fake ERR-RULE-CREATE 500 would hide that from
    // both the caller and the logs.
    if (error instanceof AppError) throw error;
    logger.error({ error }, "Failed to create access rules");
    throw error;
  }
}

/**
 * List all access rules for a tenant, optionally filtered by principal or document type.
 */
export async function listAccessRules(
  tenantId: string,
  filters?: {
    principalType?: "user" | "role";
    principalId?: string;
    documentTypeId?: string;
  }
): Promise<AccessRule[]> {
  try {
    const where: any = { tenantId };

    if (filters?.principalType) {
      where.principalType = filters.principalType;
    }
    if (filters?.principalId) {
      where.principalId = filters.principalId;
    }
    if (filters?.documentTypeId !== undefined) {
      where.documentTypeId = filters.documentTypeId || null;
    }

    const rules = await AccessRule.findAll({
      where,
      order: [["createdAt", "DESC"]],
      include: [{ model: User, as: "granter", attributes: ["id", "firstName", "lastName", "email"] }],
    });

    return rules;
  } catch (error) {
    logger.error({ error, filters }, "Failed to list access rules");
    throw error;
  }
}

/**
 * Get a single access rule by ID.
 */
export async function getAccessRule(ruleId: string, tenantId: string): Promise<AccessRule> {
  try {
    const rule = await AccessRule.findOne({
      where: {
        id: ruleId,
        tenantId
      },
      include: [{ model: User, as: "granter", attributes: ["id", "firstName", "lastName", "email"] }],
    });

    if (!rule) {
      throw new AppError(404, "ERR-RULE-NOT-FOUND", "Access rule not found");
    }

    return rule;
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ error, ruleId }, "Failed to get access rule");
    throw error;
  }
}

/**
 * Delete an access rule by ID.
 */
export async function deleteAccessRule(ruleId: string, tenantId: string, deletedBy?: string): Promise<void> {
  try {
    const rule = await getAccessRule(ruleId, tenantId); // Verify it exists

    await runInTransaction(async (tx) => {
      await AccessRule.destroy({
        where: {
          id: ruleId,
          tenantId
        },
        transaction: tx,
      });

      // Security-critical: awaited so audit is atomic with the deletion.
      await writeAuditLog({
        eventType: AUDIT_EVENTS.ACCESS_RULE_DELETED,
        userId: deletedBy ?? null,
        tenantId,
        actionDetails: { ruleId, principalType: rule.principalType, principalId: rule.principalId, permission: rule.permission, tenantId },
      });

      // Same reasoning as createAccessRules: this tx is the request's own
      // ambient transaction, which doesn't commit until the request
      // finishes — invalidating right after this callback returns would
      // clear the cache while the deletion is still uncommitted, letting a
      // concurrent request miss cache and re-cache the stale pre-deletion
      // resolution.
      tx.afterCommit(() => {
        void invalidateTenantACL(tenantId).catch((err) => {
          logger.warn({ err, tenantId, ruleId }, "Failed to invalidate tenant ACL cache after access-rule deletion commit");
        });
      });
    });

    logger.info({ ruleId }, "Access rule deleted");
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ error, ruleId }, "Failed to delete access rule");
    throw error;
  }
}
