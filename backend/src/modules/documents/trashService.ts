// S4-16: Soft delete to _trash/ with purge_pending record

import crypto from "node:crypto";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { Op } from "sequelize";
import {
  Document, OutboxEvent, PurgePending, DocumentVersion, DocumentDek,
  CertificateOfDestruction, ApprovalChain, ApprovalStep, AuditStageReview, AclEntry,
  DocLock, DocumentCheckout, SignatureRequest, SignatureRecipient, FormInstance, User,
} from "../../infrastructure/database/index.js";
import { getStorageAdapter } from "../../infrastructure/storage/StorageAdapter.js";
import { requireDocumentAccess, requireLegalHoldClear, assertNotTerminalState } from "../../shared/documentGuards.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { decrementStorageUsed, reserveStorageQuota } from "./quotaService.js";
import { runInTransaction } from "../../shared/transaction.js";
import { assertStatusPermission } from "./statusPermissions.service.js";

type CurrentUser = {
  userId: string;
  role: string;
  tenantId: string;
  roles?: readonly string[];
};

const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * S4-16: Soft delete document to trash
 * - Moves storage key from documents/ to _trash/{tenantId}/
 * - Sets status to 'trashed' and trashed_at timestamp
 * - Creates purge_pending record with 30-day timer
 * - Legal hold blocks this operation
 */
export async function moveToTrash(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId, {
    include: [
      {
        model: DocumentVersion,
        as: "versions",
        separate: true,
        order: [["createdAt", "DESC"]]
      }
    ]
  });

  if (!document) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  if (document.deletedAt || document.status === "TRASHED") {
    throw new AppError(400, "ERR-ALREADY-TRASHED", "Document is already in trash");
  }

  requireDocumentAccess(document, user);
  await assertStatusPermission(document, "trash", user);
  requireLegalHoldClear(document); // S4-16: Legal hold blocks trash
  assertNotTerminalState(document);

  const storage = getStorageAdapter();
  const versions = (document as any).versions || [];

  // FIX (platform audit finding 4.3): this used to move/delete storage bytes
  // FIRST, before any of the DB writes below. Since those DB writes all
  // auto-join the ambient request transaction (see shared/transaction.ts)
  // and only truly commit at response-finish time — not synchronously when
  // this function returns — a failure in any later statement rolled the
  // document back to its pre-trash state while the file it pointed to had
  // *already* been irreversibly moved away: a "ghost" document identical to
  // the bug executePurge (below in this file) was already rewritten once to
  // avoid. Fixed the same way: compute the new key and update the DB row
  // now (rollback-safe, part of the same transaction), and defer the actual
  // storage move to `tx.afterCommit()` — per this project's own convention
  // (the `runInTransaction` convention) — so it only ever runs
  // once the trash is genuinely, permanently committed.
  const versionMoves = versions.map((version: any) => ({
    version,
    oldKey: version.storageKey as string,
    newKey: `_trash/${user.tenantId}/${version.storageKey}`,
    mimeType: version.mimeType,
  }));

  for (const { version, newKey } of versionMoves) {
    // Update version storage key
    await version.update({ storageKey: newKey });
  }

  // Register the deferred physical move now — afterCommit only actually
  // fires once the transaction this document update is part of truly
  // commits (immediately if there's no ambient transaction, or at
  // response-finish time if there is), never on a rollback. Safe to
  // register before the rest of this function's DB work runs: if anything
  // later throws, the whole transaction rolls back and this callback simply
  // never fires — no partial storage move to clean up.
  await runInTransaction(async (tx) => {
    tx.afterCommit(async () => {
      for (const { oldKey, newKey, mimeType } of versionMoves) {
        try {
          const exists = await storage.exists(oldKey + ".enc");
          if (exists) {
            const buffer = await storage.get(oldKey + ".enc");
            await storage.put(newKey + ".enc", buffer, mimeType);
            await storage.delete(oldKey + ".enc");
            logger.debug({ oldKey, newKey }, "Moved file to trash");
          }

          const indexExists = await storage.exists(oldKey + ".index.json");
          if (indexExists) {
            const indexBuffer = await storage.get(oldKey + ".index.json");
            await storage.put(newKey + ".index.json", indexBuffer, "application/json");
            await storage.delete(oldKey + ".index.json");
          }
        } catch (error) {
          // The document row is already committed as TRASHED at this point
          // (that's the whole point of doing this after commit) — there is
          // nothing left to roll back. Log loudly with everything needed to
          // find and fix it by hand; the existing orphaned-storage sweeper
          // can also reconcile a version whose DB key points at a location
          // the physical bytes never actually reached.
          logger.error(
            { error, documentId, oldKey, newKey },
            "Failed to move file to trash AFTER the document was already committed as trashed — storage bytes still sit at the ORIGINAL key, DB now points at the trash key. Needs manual reconciliation.",
          );
        }
      }
    });
  });

  // Update document status — remember the pre-trash status so restore can
  // return the document to its exact lifecycle position (not a blanket DRAFT).
  await document.update({
    preTrashStatus: document.status,
    status: "TRASHED",
    deletedAt: new Date()
  });

  // M4: cancel any live approval chain and pending audit review so trashing a
  // document doesn't leave approvers/auditors a live task pointing at a trashed
  // item (and, for audits, the ability to flip a trashed doc's status). The
  // approval chain has a proper CANCELLED terminal state; pending audit reviews
  // are removed (a fresh one is created on any future resubmit).
  //
  // FIX: a FORM_INSTANCE approval chain/review is keyed by FormInstance.id, not
  // Document.id — this used to only ever match itemType:"DOCUMENT" rows, so
  // trashing a form instance's document left its chain/review orphaned and
  // still actionable (decideStep/resubmitToAudit would still succeed against
  // a trashed item's stale step).
  const backingFormInstance = await FormInstance.findOne({ where: { documentId }, attributes: ["id"] });
  const itemFilter = backingFormInstance
    ? { [Op.or]: [{ itemType: "DOCUMENT", itemId: documentId }, { itemType: "FORM_INSTANCE", itemId: backingFormInstance.id }] }
    : { itemType: "DOCUMENT", itemId: documentId };

  const liveChains = await ApprovalChain.findAll({
    where: { ...itemFilter, status: { [Op.in]: ["IN_REVIEW", "CHANGES_REQUESTED"] } },
  });
  for (const chain of liveChains) {
    await ApprovalStep.update(
      { status: "CANCELLED" },
      { where: { chainId: chain.id, status: { [Op.in]: ["PENDING", "WAITING"] } } },
    );
    await chain.update({ status: "CANCELLED", completedAt: new Date() });
  }
  await AuditStageReview.destroy({ where: { ...itemFilter, status: "PENDING" } });
  // audit 2026-08-11 lifecycle sweep #7: this cascade cancels chains
  // and voids signature requests but never told an open viewer — a second
  // approver/signer with the page open saw no update until a remount or the
  // 30s staleTime lapsed. Only fired when something was actually live.
  if (liveChains.length > 0) {
    await OutboxEvent.create({
      documentId,
      type: "APPROVAL_CHAIN.UPDATED",
      channel: "WEBSOCKET",
      payload: JSON.stringify({ documentId, change: "trashed", departmentId: document.departmentId, tenantId: user.tenantId }),
    });
  }

  // Release any lock/checkout so a checkout that survived trashing can no longer
  // be used to upload a new version onto a purge-pending row (S19 audit finding —
  // TRASHED was not terminal and trash left the checkout in place).
  await DocLock.destroy({ where: { documentId } });
  await DocumentCheckout.destroy({ where: { documentId } });

  // Void any live e-sign ceremony. Without this, external recipients holding
  // access-token links keep signing a trashed, purge-scheduled document — the
  // completion handler even mutates its folder — because signDocument gates only
  // on the request status (S19 audit finding). Void the request and kill the
  // recipients' access tokens so the public signing links stop working.
  const liveSignatureRequests = await SignatureRequest.findAll({
    where: { documentId, status: { [Op.in]: ["sent", "partially_signed"] } },
    attributes: ["id"],
  });
  if (liveSignatureRequests.length > 0) {
    const requestIds = liveSignatureRequests.map((r) => r.id);
    await SignatureRequest.update(
      { status: "voided", voidedReason: "Document moved to trash" },
      { where: { id: { [Op.in]: requestIds } } },
    );
    await SignatureRecipient.update(
      { accessToken: null, accessTokenHash: null, accessTokenExpires: null },
      { where: { signatureRequestId: { [Op.in]: requestIds }, status: { [Op.in]: ["pending", "viewed"] } } },
    );
    await OutboxEvent.create({
      documentId,
      type: "SIGNING.UPDATED",
      channel: "WEBSOCKET",
      payload: JSON.stringify({ documentId, change: "trashed", departmentId: document.departmentId, tenantId: user.tenantId }),
    });
  }

  await OutboxEvent.create({
    documentId,
    type: "SEARCH_INDEX_DELETE",
    channel: "SEARCH_INDEX",
    payload: JSON.stringify({ documentId, tenantId: user.tenantId }),
  });

  // S4-16: Create purge_pending record with 30-day timer
  const purgeAfter = new Date();
  purgeAfter.setDate(purgeAfter.getDate() + DEFAULT_TRASH_RETENTION_DAYS);

  await PurgePending.create({
    documentId,
    stagedAt: new Date(),
    // Maker–checker (D12): the person who put it in trash counts as the
    // stager — they cannot also approve its permanent destruction.
    stagedById: user.userId,
    purgeAfter,
    approvedById: null,
    approvedAt: null,
    status: "PENDING"
  });

  // S4-10: Decrement storage usage (document moved to trash)
  const totalSize = versions.reduce((sum: number, v: any) => sum + Number(v.fileSize), 0);
  await decrementStorageUsed(user.tenantId, totalSize);

  // M11: the retention pipeline warns owners 90/30 days before disposal, but
  // the trash pipeline destroyed documents with zero emails — the owner of a
  // document someone else trashed had no idea a permanent, certified purge was
  // 30 days away. Tell them now, with the date.
  await OutboxEvent.create({
    documentId,
    type: "TRASH.SCHEDULED_PURGE",
    channel: "EMAIL",
    payload: JSON.stringify({
      documentId,
      documentName: document.documentName ?? document.title,
      trashedBy: user.userId,
      purgeAfter: purgeAfter.toISOString(),
      retentionDays: DEFAULT_TRASH_RETENTION_DAYS,
      recipientUserId: document.ownerId,
      tenantId: user.tenantId,
    }),
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_TRASHED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: {
      purgeAfter: purgeAfter.toISOString(),
      retentionDays: DEFAULT_TRASH_RETENTION_DAYS
    }
  });

  logger.info({ documentId, purgeAfter }, "Document moved to trash");

  return {
    success: true,
    purgeAfter,
    message: `Document will be permanently deleted after ${DEFAULT_TRASH_RETENTION_DAYS} days`
  };
}

/**
 * Restore document from trash
 */
export async function restoreFromTrash(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId, {
    include: [
      {
        model: DocumentVersion,
        as: "versions",
        separate: true,
        order: [["createdAt", "DESC"]]
      }
    ]
  });

  if (!document) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  if (document.status !== "TRASHED") {
    throw new AppError(409, "ERR-NOT-IN-TRASH", "Document is not in trash");
  }

  requireDocumentAccess(document, user);
  await assertStatusPermission(document, "restore", user);

  const storage = getStorageAdapter();
  const versions = (document as any).versions || [];
  const restoredStatus = document.preTrashStatus ?? "DRAFT";

  // Concurrent-restore guard (S19 audit finding): the status check above is not
  // atomic with the work below, so two concurrent restores (e.g. a double-click)
  // could both pass it and both reserve quota, inflating storageUsedBytes by
  // 2×totalSize. Claim the row with a single conditional UPDATE that only the
  // first restore wins (TRASHED → restoredStatus); the loser gets 0 rows and a
  // 409. This also performs the final status flip up-front, so it is reverted on
  // any failure below.
  const [claimed] = await Document.update(
    { status: restoredStatus, preTrashStatus: null, deletedAt: null },
    { where: { id: documentId, status: "TRASHED" } },
  );
  if (claimed === 0) {
    throw new AppError(409, "ERR-NOT-IN-TRASH", "Document is not in trash (already restored?)");
  }

  // M10: trashing decrements storage usage, so a tenant can fill the freed
  // space with new uploads and then restore — silently blowing past the quota
  // ceiling every upload path enforces. Reserve the bytes atomically BEFORE
  // moving anything back (413 if it no longer fits), and revert the claim if
  // reservation itself fails (nothing to release — a failed reserve throws
  // before adding anything).
  const totalSize = versions.reduce((sum: number, v: any) => sum + Number(v.fileSize), 0);
  try {
    await reserveStorageQuota(user.tenantId, totalSize);
  } catch (error) {
    await Document.update(
      { status: "TRASHED", preTrashStatus: restoredStatus, deletedAt: new Date() },
      { where: { id: documentId } },
    ).catch(() => undefined);
    throw error;
  }

  // FIX (same class of bug as platform audit finding 4.3, applied here too):
  // this used to move physical bytes out of trash synchronously, one version
  // at a time, updating each version's storageKey right after its own move
  // succeeded. If a LATER version's move then failed, the catch below only
  // reverted the Document's status back to TRASHED — not the storageKey of
  // versions already updated earlier in the SAME loop. Since an error
  // response rolls back this request's whole ambient transaction
  // (shared/middleware.ts), those earlier versions' rows would revert to
  // pointing at the trash key while their actual bytes had already been
  // irreversibly moved to the restored key — the exact ghost-document
  // mismatch 4.3 fixed for the trash direction, just for restore. Fixed the
  // same way: update every version's storageKey now (rollback-safe, part of
  // the same transaction as the claim above), and defer the physical byte
  // move to tx.afterCommit() so it only ever runs once the restore is
  // genuinely, permanently committed.
  const versionMoves = versions.map((version: any) => {
    const trashKey = version.storageKey as string;
    const originalKey = trashKey.replace(`_trash/${user.tenantId}/`, "");
    return { version, trashKey, originalKey, mimeType: version.mimeType };
  });

  for (const { version, originalKey } of versionMoves) {
    await version.update({ storageKey: originalKey });
  }

  await runInTransaction(async (tx) => {
    tx.afterCommit(async () => {
      for (const { trashKey, originalKey, mimeType } of versionMoves) {
        try {
          const exists = await storage.exists(trashKey + ".enc");
          if (exists) {
            const buffer = await storage.get(trashKey + ".enc");
            await storage.put(originalKey + ".enc", buffer, mimeType);
            await storage.delete(trashKey + ".enc");
          }

          const indexExists = await storage.exists(trashKey + ".index.json");
          if (indexExists) {
            const indexBuffer = await storage.get(trashKey + ".index.json");
            await storage.put(originalKey + ".index.json", indexBuffer, "application/json");
            await storage.delete(trashKey + ".index.json");
          }
        } catch (error) {
          // The document row is already committed back to restoredStatus at
          // this point — there is nothing left to roll back. Log loudly with
          // everything needed to find and fix it by hand; the existing
          // orphaned-storage sweeper can also reconcile a version whose DB
          // key points at a location the physical bytes never actually
          // reached.
          logger.error(
            { error, documentId, trashKey, originalKey },
            "Failed to move file out of trash AFTER the document was already committed as restored — storage bytes still sit at the TRASH key, DB now points at the restored key. Needs manual reconciliation.",
          );
        }
      }
    });
  });

  // Status was already flipped to restoredStatus by the atomic claim above.

  await OutboxEvent.create({
    documentId,
    type: "SEARCH_INDEX",
    channel: "SEARCH_INDEX",
    payload: JSON.stringify({ documentId, tenantId: user.tenantId }),
  });

  // Cancel purge_pending
  await PurgePending.destroy({ where: { documentId } });

  // Storage usage was already re-added by the atomic quota reservation above
  // (M10) — no separate increment here or the restore would double-count.

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_RESTORED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: { restoredFrom: "trash" }
  });

  logger.info({ documentId }, "Document restored from trash");

  return { success: true, message: "Document restored successfully" };
}

/**
 * Permanently destroy a document: delete every version's ciphertext from
 * storage, wipe the encryption key, remove the document + version rows,
 * de-index from search, and issue a tamper-evident Certificate of Destruction.
 *
 * This is the ONE real deletion path. Both the automated purge-cooling worker
 * and the manual admin purge-approval funnel through it — before this, "purge"
 * only flipped a status and the bytes lived forever.
 *
 * `authorisedById` is the approver (or null for the automated cooling job).
 */
export async function executePurge(
  documentId: string,
  authorisedById: string | null,
  disposalMethod = "CERTIFIED_DELETION",
): Promise<{ success: boolean; certificateReference: string }> {
  const document = await Document.findByPk(documentId, {
    include: [{ model: DocumentVersion, as: "versions", separate: true }],
  });
  if (!document) throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  if (document.isOnLegalHold)
    throw new AppError(409, "ERR-HOLD-ACTIVE", "Cannot purge a document under legal hold");

  const storage = getStorageAdapter();
  const versions = (document as any).versions || [];
  const reference = `COD-${new Date().getFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  // Same FORM_INSTANCE polymorphic-id fix as moveToTrash above — a form
  // instance's chain/review is keyed by FormInstance.id, not Document.id.
  const purgeBackingFormInstance = await FormInstance.findOne({ where: { documentId }, attributes: ["id"] });
  const purgeItemFilter = purgeBackingFormInstance
    ? { [Op.or]: [{ itemType: "DOCUMENT", itemId: documentId }, { itemType: "FORM_INSTANCE", itemId: purgeBackingFormInstance.id }] }
    : { itemType: "DOCUMENT", itemId: documentId };

  // FIX: this used to delete storage bytes FIRST, then run the DB
  // transaction (certificate + row deletion). If the transaction then
  // failed, the document row survived — still listed and searchable — while
  // pointing at ciphertext that no longer existed: a permanently broken
  // "ghost" document, worse than the alternative. Reordered so the DB
  // transaction (fully rollback-safe) commits FIRST; storage deletion
  // happens only after the document is genuinely gone from the system. If
  // storage deletion then partially fails, the result is orphaned ciphertext
  // on disk — harmless residual disk usage the existing orphaned-storage
  // sweeper is already designed to reconcile — not a broken document.
  await runInTransaction(async (tx) => {
    await CertificateOfDestruction.create(
      {
        reference,
        documentIds: JSON.stringify([documentId]),
        disposalMethod,
        authorisedById: authorisedById ?? document.ownerId,
        authorisedAt: new Date(),
      } as any,
      { transaction: tx },
    );
    // Remove the encryption key and version rows, then the document.
    await DocumentDek.destroy({ where: { documentId }, transaction: tx });
    await DocumentVersion.destroy({ where: { documentId }, transaction: tx });
    await PurgePending.destroy({ where: { documentId }, transaction: tx });
    // M5: the approval engine tables are polymorphic (item_type/item_id) with NO
    // FK to documents, so they do not cascade — purging left permanent orphan
    // chain/step/audit rows. Remove them here (deleting the chain cascades its
    // steps via the ON DELETE CASCADE FK).
    await ApprovalChain.destroy({ where: purgeItemFilter, transaction: tx });
    await AuditStageReview.destroy({ where: purgeItemFilter, transaction: tx });
    // acl_entries is polymorphic too (resource_type/resource_id, no FK): without this, every certified destruction left permanent
    // grants pointing at a document that no longer exists.
    await AclEntry.destroy({ where: { tenantId: document.tenantId, resourceType: "document", resourceId: documentId }, transaction: tx });
    await Document.destroy({ where: { id: documentId }, transaction: tx, force: true });
    await OutboxEvent.create(
      {
        documentId: null,
        type: "SEARCH_INDEX_DELETE",
        channel: "SEARCH_INDEX",
        payload: JSON.stringify({ documentId, tenantId: document.tenantId }),
      },
      { transaction: tx },
    );
    // M11: certified destruction used to be entirely silent to the owner. The
    // recipient travels in the payload — by dispatch time the document row no
    // longer exists to resolve an owner from.
    await OutboxEvent.create(
      {
        documentId: null,
        type: "DOCUMENT.PURGED",
        channel: "EMAIL",
        payload: JSON.stringify({
          documentId,
          documentName: document.documentName ?? document.title,
          certificateReference: reference,
          disposalMethod,
          recipientUserId: document.ownerId,
          tenantId: document.tenantId,
        }),
      },
      { transaction: tx },
    );

    // FIX (runInTransaction conversion): storage deletion must not happen
    // until the row deletion above is DURABLY committed — that's the whole
    // point of the reordering documented above. When this reuses the ambient
    // request transaction, this callback returns long before the real commit
    // (which happens at response-finish time — see shared/middleware.ts), so
    // deleting ciphertext right after the callback resolves would reintroduce
    // exactly the "ghost document" hazard this function was already
    // rewritten once to avoid: if the outer request transaction later rolled
    // back, the document/version rows would come back while their bytes were
    // already irreversibly gone. tx.afterCommit is the one hook that fires at
    // the true commit point in both the ambient-reuse case and the
    // fresh-transaction fallback (e.g. when called from
    // RetentionPurgeWorker), so the storage sweep is deferred to it and run
    // fire-and-forget (failures are already tolerated/logged, never thrown).
    tx.afterCommit(() => {
      void (async () => {
        let storageDeleteFailures = 0;
        for (const version of versions) {
          for (const key of [version.storageKey, `_trash/${document.tenantId}/${version.storageKey}`]) {
            for (const suffix of [".enc", ".index.json"]) {
              try {
                if (await storage.exists(key + suffix)) await storage.delete(key + suffix);
              } catch (err) {
                storageDeleteFailures++;
                logger.warn({ err, key: key + suffix, documentId }, "purge: storage delete failed (continuing)");
              }
            }
          }
        }
        if (storageDeleteFailures > 0) {
          logger.error(
            { documentId, reference, storageDeleteFailures },
            "purge: certificate of destruction issued but some ciphertext could not be deleted — orphaned bytes require the storage sweeper",
          );
        }
      })().catch((err) => {
        logger.error({ err, documentId, reference }, "purge: unexpected error during post-commit storage cleanup");
      });
    });
  });

  await writeAuditLog({
    eventType: AUDIT_EVENTS.PURGE_EXECUTED,
    tenantId: document.tenantId,
    userId: authorisedById,
    documentId,
    actionDetails: { certificateReference: reference, disposalMethod, documentName: document.documentName },
  }).catch((err) => logger.error({ err }, "purge audit write failed"));

  logger.info({ documentId, reference }, "Document permanently purged with certificate of destruction");
  return { success: true, certificateReference: reference };
}

/**
 * Hard-delete a DRAFT document immediately — no trash, no 30-day/7-day
 * cooling period, no maker-checker approval. A draft has never been filed,
 * reviewed, audited, or signed, so unlike executePurge there is no managed
 * record whose destruction needs to be certified; requiring a second
 * approver to let someone discard their own unpublished scratch work is
 * exactly the friction Trash + staged purge exist to avoid for real records.
 *
 * Reuses the same row/key teardown as executePurge, minus the Certificate of
 * Destruction and the owner-notification email (the caller is the one doing
 * the deleting).
 */
export async function deleteDraftPermanently(documentId: string, user: CurrentUser) {
  const document = await Document.findByPk(documentId, {
    include: [{ model: DocumentVersion, as: "versions", separate: true }],
  });
  if (!document) throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");

  requireDocumentAccess(document, user);
  await assertStatusPermission(document, "delete_permanent", user);
  requireLegalHoldClear(document);

  if (document.status !== "DRAFT") {
    throw new AppError(
      409,
      "ERR-NOT-DRAFT",
      "Only draft documents can be permanently deleted directly; other documents must go through Trash and the purge approval flow",
    );
  }

  const storage = getStorageAdapter();
  const versions = (document as any).versions || [];
  const backingFormInstance = await FormInstance.findOne({ where: { documentId }, attributes: ["id"] });
  const itemFilter = backingFormInstance
    ? { [Op.or]: [{ itemType: "DOCUMENT", itemId: documentId }, { itemType: "FORM_INSTANCE", itemId: backingFormInstance.id }] }
    : { itemType: "DOCUMENT", itemId: documentId };

  // Same ordering as executePurge above: the DB deletion (fully rollback-safe)
  // commits FIRST; storage bytes are only removed once the document is
  // genuinely, durably gone — never the other way around.
  await runInTransaction(async (tx) => {
    await DocumentDek.destroy({ where: { documentId }, transaction: tx });
    await DocumentVersion.destroy({ where: { documentId }, transaction: tx });
    await DocLock.destroy({ where: { documentId }, transaction: tx });
    await DocumentCheckout.destroy({ where: { documentId }, transaction: tx });
    // A draft should never actually have a live approval chain or audit
    // review, but clean up defensively — same safety net executePurge keeps.
    await ApprovalChain.destroy({ where: itemFilter, transaction: tx });
    await AuditStageReview.destroy({ where: itemFilter, transaction: tx });
    // access rows are polymorphic (no FK), so they do not cascade with the document
    await AclEntry.destroy({ where: { tenantId: document.tenantId, resourceType: "document", resourceId: documentId }, transaction: tx });
    await Document.destroy({ where: { id: documentId }, transaction: tx, force: true });
    await OutboxEvent.create(
      {
        documentId: null,
        type: "SEARCH_INDEX_DELETE",
        channel: "SEARCH_INDEX",
        payload: JSON.stringify({ documentId, tenantId: document.tenantId }),
      },
      { transaction: tx },
    );

    tx.afterCommit(() => {
      void (async () => {
        for (const version of versions) {
          for (const suffix of [".enc", ".index.json"]) {
            const key = `${version.storageKey}${suffix}`;
            try {
              if (await storage.exists(key)) await storage.delete(key);
            } catch (err) {
              logger.warn({ err, documentId, key }, "draft delete: storage cleanup failed (continuing) — orphaned-storage sweeper will reconcile");
            }
          }
        }
      })().catch((err) => {
        logger.error({ err, documentId }, "draft delete: unexpected error during post-commit storage cleanup");
      });
    });
  });

  const totalSize = versions.reduce((sum: number, v: any) => sum + Number(v.fileSize), 0);
  if (totalSize > 0) {
    await decrementStorageUsed(user.tenantId, totalSize);
  }

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_PERMANENTLY_DELETED,
    userId: user.userId,
    userRole: user.role,
    documentId,
    actionDetails: { fromStatus: "DRAFT", documentName: document.documentName ?? document.title },
  });

  logger.info({ documentId }, "Draft document permanently deleted");
  return { success: true, message: "Draft permanently deleted" };
}

/**
 * Look up an already-issued Certificate of Destruction by its reference.
 * There was previously no way to see this again after the initial purge
 * response's toast disappeared — the reference was returned once and never
 * persisted anywhere retrievable, and even that response never resolved
 * authorisedById to a name. Route-level requirePermission(DOCUMENT_PURGE)
 * is the only access control here — the table carries no tenantId (it
 * predates multi-tenant RLS and documents a completed, irreversible action
 * rather than live tenant data), so this intentionally is not tenant-scoped
 * beyond that permission gate.
 */
export async function getCertificateOfDestruction(reference: string) {
  const cert = await CertificateOfDestruction.findOne({
    where: { reference },
    include: [{ model: User, as: "authorisedBy", attributes: ["id", "firstName", "lastName", "email"] }],
  });
  if (!cert) {
    throw new AppError(404, "ERR-CERTIFICATE-NOT-FOUND", "Certificate of destruction not found");
  }
  return cert;
}
