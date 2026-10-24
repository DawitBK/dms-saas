// SPRINT-3 (S3-07): ACL Management Service
// CRUD operations for ACL entries with cache invalidation

import { randomUUID } from "crypto";
import { z } from "zod";
import { UniqueConstraintError } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import {
  AclEntry, Document, FolderNode, Department, WorkflowInstance, WorkflowTask, UserTenant, User, Role,
} from "../../infrastructure/database/models/index.js";
import { runInTransaction } from "../../shared/transaction.js";
import { invalidateResourceACL } from "../../infrastructure/cache/aclCache.js";
import type { AclResourceType } from "../../shared/resolveACL.js";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../config/permissions.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";

/**
 * SECURITY FIX (audit 2026-08-11 roles/permissions sweep #1):
 * createAclEntry/createBulkAclEntries previously wrote an ACL row for any
 * resourceId with no check that the underlying resource actually belongs to
 * the caller's own tenant — an ACL_MANAGE holder in tenant A could write a
 * DENY row against a tenant B document/folder/department id, and resolveACL
 * (whose AclEntry.findAll query has no tenantId filter) would honor it for
 * tenant B's own users. Retention/legal-hold resources have no per-tenant
 * concept in their own schema (retention policies are global by design; legal
 * holds are scoped via the documents they're applied to), so they're
 * intentionally not checked here — everything that actually carries a
 * tenantId column is.
 */
async function assertResourceInTenant(resourceType: AclResourceType, resourceId: string, tenantId: string): Promise<void> {
  let owningTenantId: string | null | undefined;
  switch (resourceType) {
    case "document":
      owningTenantId = (await Document.findByPk(resourceId, { attributes: ["tenantId"] }))?.tenantId;
      break;
    case "folder":
      owningTenantId = (await FolderNode.findByPk(resourceId, { attributes: ["tenantId"] }))?.tenantId;
      break;
    case "department":
      owningTenantId = (await Department.findByPk(resourceId, { attributes: ["tenantId"] }))?.tenantId;
      break;
    case "workflow":
      owningTenantId = (await WorkflowInstance.findByPk(resourceId, { attributes: ["tenantId"] }))?.tenantId;
      break;
    case "workflow_task":
      owningTenantId = (await WorkflowTask.findByPk(resourceId, { attributes: ["tenantId"] }))?.tenantId;
      break;
    default:
      return;
  }
  if (owningTenantId == null || owningTenantId !== tenantId) {
    throw new AppError(404, "ERR-RESOURCE-NOT-FOUND", "Resource not found");
  }
}

/** Same principle for the principal side: a `principalType: "user"` grant/
 *  revoke must target a user who is actually a member of the caller's
 *  tenant, and a `principalType: "role"` grant must target a role NAME that
 *  actually resolves to something at authorization time.
 *
 *  FIX: role principals had no validation at all before this — the Access
 *  Control Center's role picker used to submit the `roles` table's UUID
 *  (`role.id`) as principalId, not the role's `name`, and this function
 *  silently accepted it. Every ACL check in the app (resolveACL.ts's role
 *  matching, requirePermission, etc.) compares principalId against the
 *  caller's JWT role NAME strings ('DEPT_MANAGER', never a UUID) — role
 *  identity throughout auth is the name, not this table's row id. A grant
 *  created with the UUID "succeeded," showed up in the grants list looking
 *  correct, and matched nothing, ever. Frontend now submits role.name; this
 *  checks the name actually resolves to a real role (built-in, via the
 *  hardcoded ROLE_PERMISSIONS map, or a tenant-created custom role via the
 *  `roles` table) so a typo or a lingering UUID fails loudly here instead of
 *  creating another silently-dead grant. */
async function assertUserPrincipalInTenant(principalType: "user" | "role", principalId: string, tenantId: string): Promise<void> {
  if (principalType === "user") {
    const membership = await UserTenant.findOne({ where: { userId: principalId, tenantId } });
    if (!membership) {
      throw new AppError(404, "ERR-USER-NOT-FOUND", "User not found in this tenant");
    }
    return;
  }
  if (principalId in ROLE_PERMISSIONS) return;
  const customRole = await Role.findOne({ where: { name: principalId } });
  if (!customRole) {
    throw new AppError(404, "ERR-ROLE-NOT-FOUND", `Role '${principalId}' does not exist — grant must target a role name, not an id`);
  }
}

export interface CreateAclEntryRequest {
  principalType: "user" | "role";
  principalId: string;
  effect: "ALLOW" | "DENY";
  permission: string;
  expiresAt?: string | null; // ISO date string or null for permanent
}

// API-1: the route forwarded req.body with no schema — `principalType` in
// particular had no enum check anywhere before this, so a malformed value
// (anything other than exactly "user") silently fell through
// assertUserPrincipalInTenant's `if (principalType === "user")` branch into
// its role-lookup branch, misreporting a bad request as ERR-ROLE-NOT-FOUND
// instead of a clear 400. Business-rule checks (tenant/principal existence,
// duplicate-grant detection, "expiresAt must be in the future") are
// deliberately NOT folded into this schema — those need a DB round trip or
// today's date, not just the request's shape, so they stay as the explicit
// checks below it.
const createAclEntrySchema = z.object({
  principalType: z.enum(["user", "role"]),
  principalId: z.string().min(1).max(100),
  effect: z.enum(["ALLOW", "DENY"]),
  permission: z.string().min(1).max(50),
  // Not z.string().datetime(): the frontend sends a bare
  // <input type="datetime-local"> value ("2026-12-31T14:30", no seconds, no
  // timezone) — Zod's strict ISO-8601 check would reject that and break
  // every real "set an ACL expiry" request. Shape-only here; the existing
  // `new Date(...)`/`isNaN` parse below still does the real validation,
  // unchanged.
  expiresAt: z.string().min(1).nullable().optional(),
});

/**
 * A role principal cannot carry a department boundary on a document or folder
 * ACL. Allowing document:read on either shape turns a department-scoped role
 * into a tenant-wide reader (folder grants inherit to every document below
 * that folder). Document read access is granted by the live department scope,
 * the owner, or an explicit user grant; tenant-wide readers use the dedicated
 * DOCUMENT_READ_ALL role permission instead.
 */
function assertDocumentReadGrantIsScoped(
  resourceType: AclResourceType,
  principalType: "user" | "role",
  permission: string,
  effect: "ALLOW" | "DENY",
): void {
  if (
    (resourceType === "document" || resourceType === "folder") &&
    principalType === "role" &&
    permission === PERMISSIONS.DOCUMENT_READ &&
    effect === "ALLOW"
  ) {
    throw new AppError(
      400,
      "ERR-ACL-DOCUMENT-READ-SCOPE",
      "Document read ALLOW grants must target a user or department; role-wide document or folder grants would bypass department scope",
    );
  }
}

/**
 * Create a new ACL entry for a resource.
 * Verifies user has ACL_MANAGE permission.
 * Invalidates cache after creation.
 */
export async function createAclEntry(
  resourceType: AclResourceType,
  resourceId: string,
  rawData: CreateAclEntryRequest,
  grantedById: string,
  tenantId: string
): Promise<AclEntry> {
  if (!resourceId) {
    throw new AppError(400, "ERR-INVALID-INPUT", "Missing required fields");
  }
  const data = createAclEntrySchema.parse(rawData);

  assertDocumentReadGrantIsScoped(resourceType, data.principalType, data.permission, data.effect);

  await assertResourceInTenant(resourceType, resourceId, tenantId);
  await assertUserPrincipalInTenant(data.principalType, data.principalId, tenantId);

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

  const duplicateGrantMessage =
    `A ${data.effect} grant for permission "${data.permission}" already exists for this ${data.principalType} on this ${resourceType}` +
    ` — edit or remove the existing grant instead of creating another one`;

  // Pre-check for a clean 409 instead of letting acl_entries_unique_grant
  // (tenant_id, resource_type, resource_id, principal_type, principal_id,
  // permission, effect — the effect IS part of the key since 2026-10-09, so a DENY can sit beside
  // an ALLOW) surface as an unhandled 500.
  const existingGrant = await AclEntry.findOne({
    where: { tenantId, resourceType, resourceId, principalType: data.principalType, principalId: data.principalId, permission: data.permission, effect: data.effect },
  });
  if (existingGrant) {
    // The department snapshot written at upload is an automatic default, not a decision (a DENY on the folder or
    // department above still closes it). Granting that same person the same access on purpose used to fail with
    // "already exists — edit or remove it", leaving the grant a closable default with no way to make it firm.
    // An explicit grant now PROMOTES the snapshot row to a deliberate one (and applies the chosen expiry).
    if (existingGrant.origin === "DEPT_SNAPSHOT" && data.effect === "ALLOW") {
      await runInTransaction(async (tx) => {
        await existingGrant.update({ origin: null, expiresAt, grantedById, updatedAt: new Date() }, { transaction: tx });
        await writeAuditLog({
          eventType: AUDIT_EVENTS.ACL_ENTRY_CREATED,
          userId: grantedById,
          tenantId,
          actionDetails: { aclId: existingGrant.id, resourceType, resourceId, principalType: data.principalType, principalId: data.principalId, effect: data.effect, permission: data.permission, tenantId, promotedFromDepartmentSnapshot: true },
        });
        tx.afterCommit(() => {
          void invalidateResourceACL(tenantId, resourceType, resourceId).catch((err) => {
            logger.warn({ err, tenantId, resourceType, resourceId }, "Failed to invalidate ACL cache after snapshot promotion");
          });
        });
      });
      return existingGrant;
    }
    throw new AppError(409, "ERR-ACL-GRANT-EXISTS", duplicateGrantMessage);
  }

  try {
    // runInTransaction (not a bare AclEntry.create with no tx), so we get a
    // real Transaction handle to defer cache invalidation to afterCommit
    // below — see the afterCommit comment for why that timing matters.
    const entry = await runInTransaction(async (tx) => {
      let created: AclEntry;
      try {
        created = await AclEntry.create(
          {
            id: randomUUID(),
            tenantId,
            resourceType,
            resourceId,
            principalType: data.principalType,
            principalId: data.principalId,
            effect: data.effect,
            permission: data.permission,
            expiresAt,
            grantedById,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          { transaction: tx }
        );
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new AppError(409, "ERR-ACL-GRANT-EXISTS", duplicateGrantMessage);
        }
        throw err;
      }

      // Security-critical: awaited (not fire-and-forget) so the audit row is
      // written atomically with the ACL change via the request's transaction.
      // If the audit write fails, the whole operation fails and rolls back.
      await writeAuditLog({
        eventType: AUDIT_EVENTS.ACL_ENTRY_CREATED,
        userId: grantedById,
        tenantId,
        actionDetails: { aclId: created.id, resourceType, resourceId, principalType: data.principalType, principalId: data.principalId, effect: data.effect, permission: data.permission, tenantId },
      });

      // tx.afterCommit, NOT called after runInTransaction() returns: this tx
      // is often the request's own ambient transaction, which doesn't commit
      // until the request finishes — invalidating right after this callback
      // returns would clear the cache while the row is still uncommitted,
      // letting a concurrent request miss cache, read the DB under READ
      // COMMITTED (still not seeing the new row), and re-cache the stale
      // pre-grant resolution with a fresh TTL. Same pattern as
      // access-rules.service.ts's createAccessRules/deleteAccessRule.
      tx.afterCommit(() => {
        void invalidateResourceACL(tenantId, resourceType, resourceId).catch((err) => {
          logger.warn({ err, tenantId, resourceType, resourceId }, "Failed to invalidate ACL cache after entry creation commit");
        });
      });

      return created;
    });

    logger.info(
      {
        aclId: entry.id,
        resourceType,
        resourceId,
        principalType: data.principalType,
        principalId: data.principalId,
        effect: data.effect
      },
      "ACL entry created"
    );

    return entry;
  } catch (error) {
    // Only ever add context and rethrow -- swallowing every non-AppError into
    // a fake ERR-ACL-CREATE 500 used to hide the REAL error (a bad UUID, a
    // pool-capacity timeout, a constraint violation) from errorHandler's
    // classifiers, which are precisely what should be deciding the status
    // code and message for anything not already an AppError.
    if (error instanceof AppError) throw error;
    logger.error({ error, resourceType, resourceId }, "Failed to create ACL entry");
    throw error;
  }
}

/**
 * List all ACL entries for a specific resource.
 */
export async function listAclEntries(
  resourceType: AclResourceType,
  resourceId: string,
  tenantId: string
): Promise<AclEntry[]> {
  try {
    const entries = await AclEntry.findAll({
      where: {
        tenantId,
        resourceType,
        resourceId
      },
      order: [["createdAt", "DESC"]],
      include: [{ model: User, as: "granter", attributes: ["id", "firstName", "lastName", "email"] }],
    });

    return entries;
  } catch (error) {
    logger.error({ error, resourceType, resourceId }, "Failed to list ACL entries");
    throw error;
  }
}

/**
 * Get a single ACL entry by ID.
 */
export async function getAclEntry(aclId: string, tenantId: string): Promise<AclEntry> {
  try {
    const entry = await AclEntry.findOne({
      where: {
        id: aclId,
        tenantId
      },
      include: [{ model: User, as: "granter", attributes: ["id", "firstName", "lastName", "email"] }],
    });

    if (!entry) {
      throw new AppError(404, "ERR-ACL-NOT-FOUND", "ACL entry not found");
    }

    return entry;
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ error, aclId }, "Failed to get ACL entry");
    throw error;
  }
}

/**
 * Delete an ACL entry by ID.
 * Invalidates cache after deletion.
 */
export async function deleteAclEntry(aclId: string, tenantId: string, deletedBy?: string): Promise<void> {
  try {
    const entry = await getAclEntry(aclId, tenantId);

    await runInTransaction(async (tx) => {
      await AclEntry.destroy({
        where: {
          id: aclId,
          tenantId
        },
        transaction: tx,
      });

      // Security-critical: awaited so audit is atomic with the deletion.
      await writeAuditLog({
        eventType: AUDIT_EVENTS.ACL_ENTRY_DELETED,
        userId: deletedBy ?? null,
        tenantId,
        actionDetails: { aclId, resourceType: entry.resourceType, resourceId: entry.resourceId, principalType: entry.principalType, principalId: entry.principalId, permission: entry.permission, tenantId },
      });

      // Same reasoning as createAclEntry above: defer invalidation until the
      // deletion has actually committed, not right after this callback returns.
      tx.afterCommit(() => {
        void invalidateResourceACL(tenantId, entry.resourceType, entry.resourceId).catch((err) => {
          logger.warn({ err, tenantId, aclId }, "Failed to invalidate ACL cache after entry deletion commit");
        });
      });
    });

    logger.info(
      {
        aclId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId
      },
      "ACL entry deleted"
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ error, aclId }, "Failed to delete ACL entry");
    throw error;
  }
}

/**
 * Delete all ACL entries for a specific principal on a resource.
 * Used when need to revoke all access for a user/role on a resource.
 */
export async function deleteAclEntriesForPrincipal(
  resourceType: AclResourceType,
  resourceId: string,
  principalType: "user" | "role",
  principalId: string,
  tenantId: string,
  requesterId: string
): Promise<number> {
  try {
    const count = await runInTransaction(async (tx) => {
      const deleted = await AclEntry.destroy({
        where: {
          tenantId,
          resourceType,
          resourceId,
          principalType,
          principalId
        },
        transaction: tx,
      });

      if (deleted > 0) {
        // audit 2026-08-11 data-flow sweep #2: bulk revoke had the
        // same missing-audit gap as bulk create above.
        await writeAuditLog({
          eventType: AUDIT_EVENTS.ACL_ENTRIES_PRINCIPAL_DELETED,
          userId: requesterId,
          tenantId,
          actionDetails: { resourceType, resourceId, principalType, principalId, deletedCount: deleted },
        });
        // Same reasoning as createAclEntry/deleteAclEntry above.
        tx.afterCommit(() => {
          void invalidateResourceACL(tenantId, resourceType, resourceId).catch((err) => {
            logger.warn({ err, tenantId, resourceType, resourceId }, "Failed to invalidate ACL cache after principal-scoped deletion commit");
          });
        });
      }

      return deleted;
    });

    if (count > 0) {
      logger.info(
        {
          resourceType,
          resourceId,
          principalType,
          principalId,
          deletedCount: count
        },
        "ACL entries deleted for principal"
      );
    }

    return count;
  } catch (error) {
    logger.error({ error, resourceType, resourceId }, "Failed to delete ACL entries for principal");
    throw error;
  }
}

/**
 * List all ACL entries for a specific principal across all resources.
 * Used for "What can this user/role access?" views.
 */
export async function listAclEntriesByPrincipal(
  principalType: "user" | "role",
  principalId: string,
  tenantId: string
): Promise<AclEntry[]> {
  try {
    const entries = await AclEntry.findAll({
      where: {
        tenantId,
        principalType,
        principalId
      },
      order: [["resourceType", "ASC"], ["resourceId", "ASC"], ["createdAt", "DESC"]],
      include: [{ model: User, as: "granter", attributes: ["id", "firstName", "lastName", "email"] }],
    });

    return entries;
  } catch (error) {
    logger.error({ error, principalType, principalId }, "Failed to list ACL entries by principal");
    throw error;
  }
}

/**
 * Create multiple ACL entries for a resource in bulk.
 * All entries share the same resource, principal, and effect.
 * Returns array of created entries.
 */
const createBulkAclEntriesSchema = z.object({
  principalType: z.enum(["user", "role"]),
  principalId: z.string().min(1).max(100),
  effect: z.enum(["ALLOW", "DENY"]),
  permissions: z.array(z.string().min(1)).min(1),
  // Same reasoning as createAclEntrySchema.expiresAt — shape-only, not a
  // strict ISO-datetime check.
  expiresAt: z.string().min(1).nullable().optional(),
});

export async function createBulkAclEntries(
  resourceType: AclResourceType,
  resourceId: string,
  rawData: {
    principalType: "user" | "role";
    principalId: string;
    effect: "ALLOW" | "DENY";
    permissions: string[];
    expiresAt?: string | null;
  },
  grantedById: string,
  tenantId: string
): Promise<AclEntry[]> {
  if (!resourceId) {
    throw new AppError(400, "ERR-INVALID-INPUT", "Missing required fields");
  }
  const data = createBulkAclEntriesSchema.parse(rawData);

  for (const permission of data.permissions) {
    assertDocumentReadGrantIsScoped(resourceType, data.principalType, permission, data.effect);
  }

  await assertResourceInTenant(resourceType, resourceId, tenantId);
  await assertUserPrincipalInTenant(data.principalType, data.principalId, tenantId);

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

  // Pre-check for a clean 409 naming exactly which permission(s) already have
  // a grant, instead of letting acl_entries_unique_grant surface as a 500 (or
  // — worse, since this is a bulkCreate — silently abort partway through with
  // no indication which rows made it in before the constraint hit).
  const existingGrants = await AclEntry.findAll({
    where: { tenantId, resourceType, resourceId, principalType: data.principalType, principalId: data.principalId, permission: data.permissions, effect: data.effect },
    attributes: ["permission"],
  });
  if (existingGrants.length > 0) {
    const already = existingGrants.map((g) => g.permission).join(", ");
    throw new AppError(
      409,
      "ERR-ACL-GRANT-EXISTS",
      `A grant already exists for this ${data.principalType} on this ${resourceType} for: ${already} — edit or remove the existing grant(s) instead of creating duplicates`,
    );
  }

  try {
    const entries = await runInTransaction(async (tx) => {
      const now = new Date();
      let created: AclEntry[];
      try {
        created = await AclEntry.bulkCreate(
          data.permissions.map((permission) => ({
            id: randomUUID(),
            tenantId,
            resourceType,
            resourceId,
            principalType: data.principalType,
            principalId: data.principalId,
            effect: data.effect,
            permission,
            expiresAt,
            grantedById,
            createdAt: now,
            updatedAt: now
          })),
          { transaction: tx }
        );
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new AppError(
            409,
            "ERR-ACL-GRANT-EXISTS",
            `A grant already exists for this ${data.principalType} on this ${resourceType} for one or more of the requested permissions`,
          );
        }
        throw err;
      }

      // audit 2026-08-11 data-flow sweep #2: the single-entry sibling
      // createAclEntry awaits an audit write inside this same transaction —
      // this bulk variant (the higher-blast-radius case: many permissions/
      // resources at once) never did, leaving ACL_ENTRIES_BULK_CREATED a dead
      // constant.
      await writeAuditLog({
        eventType: AUDIT_EVENTS.ACL_ENTRIES_BULK_CREATED,
        userId: grantedById,
        tenantId,
        actionDetails: {
          resourceType, resourceId, principalType: data.principalType, principalId: data.principalId,
          effect: data.effect, permissions: data.permissions, count: created.length,
        },
      });

      // Same reasoning as createAclEntry above.
      tx.afterCommit(() => {
        void invalidateResourceACL(tenantId, resourceType, resourceId).catch((err) => {
          logger.warn({ err, tenantId, resourceType, resourceId }, "Failed to invalidate ACL cache after bulk entry creation commit");
        });
      });

      return created;
    });

    logger.info(
      {
        resourceType,
        resourceId,
        principalType: data.principalType,
        principalId: data.principalId,
        effect: data.effect,
        count: entries.length
      },
      "Bulk ACL entries created"
    );

    return entries;
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error({ error, resourceType, resourceId }, "Failed to create bulk ACL entries");
    throw error;
  }
}
