// S4-12: Document lock service using doc_locks table
// S4-14: Force unlock functionality

import { Op, UniqueConstraintError } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { DocLock, Document, DocumentCheckout, Tenant, User } from "../../infrastructure/database/index.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { fanOut } from "../notifications/notifications.service.js";
import { requireDocumentAccess, requireLegalHoldClear, assertNotTerminalState } from "../../shared/documentGuards.js";
import { PERMISSIONS, userHasPermission } from "../../config/permissions.js";
import { withWorkerTenantContext } from "../../shared/workerTenantContext.js";
import { logger } from "../../core/logger.js";
import { assertStatusPermission } from "./statusPermissions.service.js";

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
  permissions?: readonly string[];
  roles?: readonly string[];
};

const DEFAULT_LOCK_DURATION_HOURS = 24;

/**
 * S4-12: Checkout document using doc_locks table
 * Returns 409 if already locked by another user
 */
export async function lockDocument(
  documentId: string,
  user: CurrentUser,
  reason?: string,
  durationHours = DEFAULT_LOCK_DURATION_HOURS
) {
  const document = await Document.findByPk(documentId);
  if (!document) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  requireDocumentAccess(document, user);
  await assertStatusPermission(document, "lock", user);
  requireLegalHoldClear(document);
  assertNotTerminalState(document);

  // Check if already locked. FIX (Finding 12): this used to block on ANY
  // existing DocLock row regardless of expiresAt, unlike getLockStatus and
  // documents.service.ts's assertNotLockedByOther, which both correctly
  // treat an expired lock as absent — so once a lock expired (before the
  // hourly releaseExpiredLocks sweep runs), status/checkout said "unlocked"
  // but calling lockDocument still 409'd as "already locked by another
  // user." Same expiry check as assertNotLockedByOther, applied here too.
  const existingLock = await DocLock.findOne({ where: { documentId } });
  const existingLockIsActive = existingLock && existingLock.expiresAt >= new Date();
  if (existingLockIsActive) {
    if (existingLock.lockedBy !== user.userId) {
      throw new AppError(409, "DOCUMENT_LOCKED", "Document is already locked by another user");
    }
    // Same user - update expiry
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + durationHours);
    await existingLock.update({ expiresAt, reason: reason ?? existingLock.reason });
    return existingLock.get({ plain: true });
  }

  if (existingLock) {
    // Expired lock, being reclaimed. There's a unique constraint on
    // documentId (see the FIX comment below), so a fresh row can't be
    // inserted while this expired one still exists — reclaim it in place
    // instead of destroy-then-create, which would reopen the same
    // check-then-act race the unique constraint exists to close.
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + durationHours);
    await existingLock.update({
      lockedBy: user.userId,
      lockedAt: new Date(),
      expiresAt,
      reason: reason ?? null,
    });

    await writeAuditLog({
      eventType: AUDIT_EVENTS.LOCK_ACQUIRED,
      userId: user.userId,
      userRole: user.role,
      documentId,
      actionDetails: { reason, expiresAt: expiresAt.toISOString(), reclaimedExpiredLock: true }
    });

    return existingLock.get({ plain: true });
  }

  // Create new lock
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + durationHours);

  // FIX: the findOne-then-create above is a check-then-act race — two
  // concurrent checkouts for the same document could both see "no lock" and
  // both reach this create(). The unique constraint on documentId now makes
  // the DB reject the loser; catch that and report it as the same 409 the
  // findOne check above would have given a slightly-slower caller, instead
  // of letting a raw constraint-violation 500 leak out.
  let lock: DocLock;
  try {
    lock = await DocLock.create({
      documentId,
      lockedBy: user.userId,
      expiresAt,
      reason: reason ?? null
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      throw new AppError(409, "DOCUMENT_LOCKED", "Document is already locked by another user");
    }
    throw error;
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LOCK_ACQUIRED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: { reason, expiresAt: expiresAt.toISOString() }
  });

  return lock.get({ plain: true });
}

/**
 * S4-12: Checkin (unlock) document
 * Only lock owner or SYSTEM_ADMIN can unlock
 */
export async function unlockDocument(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId);
  if (!document) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  requireDocumentAccess(document, user);
  await assertStatusPermission(document, "unlock", user);

  const lock = await DocLock.findOne({ where: { documentId } });
  if (!lock) {
    throw new AppError(409, "ERR-NOT-LOCKED", "Document is not locked");
  }

  if (lock.lockedBy !== user.userId && !userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.ACL_BYPASS_ADMIN)) {
    throw new AppError(403, "ERR-LOCK-OWNER-REQUIRED", "Only lock owner or admin can unlock");
  }

  await lock.destroy();

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LOCK_RELEASED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: { releasedBy: user.userId }
  });

  return { success: true };
}

/**
 * S4-14: Force unlock (DEPT_MANAGER only)
 * Requires mandatory reason (min 10 chars)
 */
export async function forceUnlock(documentId: string, user: CurrentUser, reason: string) {
  const forceUnlockSubject = { role: user.role, permissions: user.permissions as never };
  if (!userHasPermission(forceUnlockSubject, PERMISSIONS.DEPT_MANAGE) && !userHasPermission(forceUnlockSubject, PERMISSIONS.ACL_BYPASS_ADMIN)) {
    throw new AppError(403, "ERR-PERMISSION-DENIED", "Only users with department:manage or admin bypass can force unlock");
  }

  if (!reason || reason.trim().length < 10) {
    throw new AppError(422, "ERR-REASON-REQUIRED", "Force unlock requires a reason of at least 10 characters");
  }

  const document = await Document.findByPk(documentId);
  if (!document) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  requireDocumentAccess(document, user); // tenant isolation — same guard as lock/unlock
  await assertStatusPermission(document, "force_unlock", user);

  // The doc_locks table (checked below) and the everyday DocumentCheckout
  // table (documents.service.ts's checkoutDocument/checkinDocument) are two
  // independent lock mechanisms, and nothing in the app ever creates a
  // doc_locks row through the UI — every real "checked out" document the
  // Force Unlock button is shown against is a DocumentCheckout row. Without
  // this, forceUnlock always 409'd "Document is not locked" for the one
  // scenario it's offered for. Release whichever of the two is actually
  // present (either, or both, if a doc_locks row exists from some other path).
  const lock = await DocLock.findOne({ where: { documentId } });
  const checkout = await DocumentCheckout.findOne({ where: { documentId } });
  if (!lock && !checkout) {
    throw new AppError(409, "ERR-NOT-LOCKED", "Document is not locked");
  }

  const originalOwner = lock?.lockedBy ?? checkout?.checkedOutBy ?? null;
  if (lock) await lock.destroy();
  if (checkout) await checkout.destroy();

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LOCK_FORCE_RELEASED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: {
      forcedBy: user.userId,
      originalOwner,
      reason,
      releasedDocLock: Boolean(lock),
      releasedCheckout: Boolean(checkout),
    }
  });

  return { success: true, message: "Lock forcefully released" };
}

/**
 * Get lock status for a document
 */
export async function getLockStatus(documentId: string) {
  const lock = await DocLock.findOne({
    where: { documentId },
    include: [{ model: User, as: "lockedByUser", attributes: ["id", "firstName", "lastName", "email"] }],
  });
  if (!lock) {
    return { locked: false };
  }

  const now = new Date();
  const isExpired = lock.expiresAt < now;

  return {
    locked: !isExpired,
    lockedBy: lock.lockedBy,
    // lockedBy alone was a bare UUID with nothing in the frontend able to
    // resolve it to a name — see associations.ts's lockedByUser addition.
    lockedByUser: (lock as unknown as { lockedByUser?: { id: string; firstName: string; lastName: string; email: string } }).lockedByUser ?? null,
    lockedAt: lock.lockedAt,
    expiresAt: lock.expiresAt,
    reason: lock.reason,
    expired: isExpired
  };
}

/**
 * S4-13: Find and release expired locks
 * Called by BullMQ worker every hour
 */
export async function releaseExpiredLocks() {
  const now = new Date();
  const released: string[] = [];

  // Document has strict tenant RLS, so a cross-tenant worker query is not
  // viable with a least-privilege DB role. Sweep each tenant in its own worker
  // context and stamp the audit record explicitly instead of producing the
  // invisible tenant_id = NULL system records this worker used to create.
  const tenants = await Tenant.findAll({ attributes: ["id"], raw: true });
  for (const tenant of tenants) {
    try {
      const ids = await withWorkerTenantContext(tenant.id, async () => {
        const expiredLocks = await DocLock.findAll({
          where: { expiresAt: { [Op.lt]: now } },
          include: [{ model: Document, as: "document", required: true, attributes: [], where: { tenantId: tenant.id } }],
        });
        for (const lock of expiredLocks) {
          await lock.destroy();
          await writeAuditLog({
            eventType: AUDIT_EVENTS.LOCK_AUTO_RELEASED,
            tenantId: tenant.id,
            userId: null,
            userRole: "SYSTEM",
            documentId: lock.documentId,
            actionDetails: { lockedBy: lock.lockedBy, expiredAt: lock.expiresAt.toISOString() },
          });
        }
        return expiredLocks.map((lock) => lock.documentId);
      });
      released.push(...ids);
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, "Expired-lock sweep failed for tenant");
    }
  }

  return { releasedCount: released.length, documentIds: released };
}

/**
 * S4-13: Send lock expiry warnings (15 min before expiry)
 * Called by BullMQ worker
 */
export async function sendLockExpiryWarnings() {
  const now = new Date();
  const warningThreshold = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes ahead
  const warnings: string[] = [];
  const tenants = await Tenant.findAll({ attributes: ["id"], raw: true });
  for (const tenant of tenants) {
    try {
      const ids = await withWorkerTenantContext(tenant.id, async () => {
        const expiringLocks = await DocLock.findAll({
          where: { expiresAt: { [Op.between]: [now, warningThreshold] } },
          include: [{ model: Document, as: "document", required: true, attributes: [], where: { tenantId: tenant.id } }],
        });
        for (const lock of expiringLocks) {
          await writeAuditLog({
            eventType: AUDIT_EVENTS.LOCK_EXPIRY_WARNING,
            tenantId: tenant.id,
            userId: lock.lockedBy,
            userRole: "USER",
            documentId: lock.documentId,
            actionDetails: {
              expiresAt: lock.expiresAt.toISOString(),
              minutesRemaining: Math.round((lock.expiresAt.getTime() - now.getTime()) / 60000),
            },
          });
          await fanOut({
            type: "LOCK_EXPIRY_WARNING",
            tenantId: tenant.id,
            recipientIds: [lock.lockedBy],
            severity: "WARNING",
            payload: { documentId: lock.documentId, expiresAt: lock.expiresAt.toISOString() },
          });
        }
        return expiringLocks.map((lock) => lock.documentId);
      });
      warnings.push(...ids);
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, "Lock-expiry warning sweep failed for tenant");
    }
  }

  return { warningCount: warnings.length, documentIds: warnings };
}
