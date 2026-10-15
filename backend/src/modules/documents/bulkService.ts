/**
 * Bulk document operations.
 *
 * Applies a single operation across many documents, one at a time, capturing
 * per-document success/failure so one rejected document never aborts the batch
 * (partial-failure reporting). This layer bounds the batch size, enforces an
 * operation-level permission gate, AND — critically — re-applies the SAME
 * per-document ACL check the single-document route middleware enforces (see
 * PER_DOC_ACL). The single-doc service functions only check tenant + a coarse
 * `*_all` permission; the real per-document ACL lives in the route's
 * `requireACL`, which bulk never passes through. Without this layer a
 * `document:archive` / `document:upload` holder could bulk-archive, trash, move,
 * re-tag or re-status ANY document in the tenant, including ones carrying an
 * explicit DENY (S19 audit finding ACL-2a/2b).
 */
import { AppError } from "../../core/AppError.js";
import { PERMISSIONS, userHasPermission, type Permission } from "../../config/permissions.js";
import type { AuthenticatedUser } from "../../shared/auth.js";
import { assertACLAllow } from "../../shared/resolveACL.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { archiveDocument, updateDocumentStatus } from "./documents.service.js";
import { moveToTrash, restoreFromTrash, deleteDraftPermanently } from "./trashService.js";
import { Document, DocumentMetadata } from "../../infrastructure/database/index.js";
import { invalidateResourceACL } from "../../infrastructure/cache/aclCache.js";
import { createAclEntry } from "../acl/acl.service.js";
import { enqueueWebsocketEvent } from "../../infrastructure/queue/outbox.js";
import { runInTransaction } from "../../shared/transaction.js";
import { logger } from "../../core/logger.js";

export type BulkOperation = "archive" | "trash" | "restore" | "status" | "move" | "tag" | "grant-acl" | "delete-permanent";

const MAX_BATCH = 100;

// Operation-level permission required to attempt the batch.
const OP_PERMISSION: Record<BulkOperation, Permission> = {
  archive: PERMISSIONS.DOCUMENT_ARCHIVE,
  trash: PERMISSIONS.DOCUMENT_ARCHIVE,
  restore: PERMISSIONS.DOCUMENT_ARCHIVE,
  status: PERMISSIONS.DOCUMENT_UPLOAD,
  move: PERMISSIONS.DOCUMENT_UPLOAD,
  tag: PERMISSIONS.DOCUMENT_UPLOAD,
  "grant-acl": PERMISSIONS.ACL_MANAGE,
  // Same gate as Discard (the DRAFT -> CANCELLED status op) — deleteDraftPermanently
  // itself re-enforces the DRAFT-only precondition per document.
  "delete-permanent": PERMISSIONS.DOCUMENT_UPLOAD,
};

// Per-document ACL permission enforced on EACH document, mirroring the
// `requireACL(...)` on the equivalent single-document route in
// documents.routes.ts. `grant-acl` is intentionally absent: the single-doc ACL
// route (POST /acl/:resourceType/:resourceId) gates on the `acl:manage`
// permission only with no per-document ACL, so bulk matches it exactly rather
// than being inconsistently stricter. assertACLAllow honours ACL_BYPASS_ADMIN.
const PER_DOC_ACL: Partial<Record<BulkOperation, string>> = {
  archive: PERMISSIONS.DOCUMENT_ARCHIVE, // /:id/archive requireACL document:archive
  trash: PERMISSIONS.DOCUMENT_ARCHIVE, // /:id/trash   requireACL document:archive
  restore: PERMISSIONS.DOCUMENT_ARCHIVE, // /:id/restore requireACL document:archive
  status: PERMISSIONS.DOCUMENT_UPLOAD, // /:id/status  requireACL document:upload
  move: PERMISSIONS.DOCUMENT_UPLOAD, // move rewrites folderId (a document write)
  tag: PERMISSIONS.DOCUMENT_UPLOAD, // tag rewrites metadata (a document write)
  "delete-permanent": PERMISSIONS.DOCUMENT_UPLOAD, // DELETE /:id requireACL document:upload
};

export interface BulkResultItem {
  documentId: string;
  success: boolean;
  error?: string;
  code?: string;
}

async function applyOne(
  operation: BulkOperation,
  documentId: string,
  user: AuthenticatedUser,
  params: {
    status?: string;
    folderId?: string | null;
    keywords?: string;
    // grant-acl params
    principalType?: "user" | "role";
    principalId?: string;
    effect?: "ALLOW" | "DENY";
    permission?: string;
    expiresAt?: string | null;
  },
): Promise<void> {
  // Per-document ACL: the same check the single-document route middleware runs.
  // Runs BEFORE the operation so a DENY'd document is rejected exactly as it
  // would be through the single-doc endpoint (assertACLAllow throws 403).
  const perDocPermission = PER_DOC_ACL[operation];
  if (perDocPermission) {
    await assertACLAllow(
      user.userId,
      user.roles,
      user.tenantId,
      { resourceType: "document", resourceId: documentId, permission: perDocPermission },
      user.permissions as string[] | undefined,
    );
  }

  switch (operation) {
    case "archive":
      await archiveDocument(documentId, user);
      return;
    case "trash":
      await moveToTrash(documentId, user);
      return;
    case "restore":
      await restoreFromTrash(documentId, user);
      return;
    case "delete-permanent":
      await deleteDraftPermanently(documentId, user);
      return;
    case "status":
      if (!params.status) throw new AppError(400, "ERR-VALIDATION", "status is required for the 'status' operation");
      await updateDocumentStatus(documentId, params.status, user);
      return;

    case "move": {
      // folderId null = root; folderId undefined = missing param = error
      if (params.folderId === undefined) {
        throw new AppError(400, "ERR-VALIDATION", "folderId is required for the 'move' operation (pass null for root)");
      }
      const doc = await Document.findOne({ where: { id: documentId, tenantId: user.tenantId } });
      if (!doc) throw new AppError(404, "ERR-NOT-FOUND", `Document ${documentId} not found`);
      // Destination-folder ACL: placing a document into a folder requires
      // folder:create on that folder, mirroring folder-reparent (H5). A move to
      // root (null) has no destination folder to check.
      if (params.folderId) {
        await assertACLAllow(
          user.userId,
          user.roles,
          user.tenantId,
          { resourceType: "folder", resourceId: params.folderId, permission: PERMISSIONS.FOLDER_CREATE },
          user.permissions as string[] | undefined,
        );
      }
      await runInTransaction(async (tx) => {
        await doc.update({ folderId: params.folderId ?? null }, { transaction: tx });
        // afterCommit, not called right after update() resolves: same race as
        // acl.service.ts — invalidating before the ambient request transaction
        // actually commits would let a concurrent read re-cache the pre-move
        // (stale) inherited-ACL resolution.
        tx.afterCommit(() => {
          void invalidateResourceACL(user.tenantId, "document", documentId).catch((err) => {
            logger.warn({ err, tenantId: user.tenantId, documentId }, "Failed to invalidate ACL cache after document move commit");
          });
        });
      });
      // Notify other viewers of this department so their lists refresh (the
      // initiator already gets the synchronous 207 response).
      await enqueueWebsocketEvent("DOCUMENT.UPDATED", {
        documentId,
        change: "move",
        departmentId: doc.departmentId,
        tenantId: user.tenantId,
      });
      return;
    }

    case "tag": {
      if (params.keywords === undefined) {
        throw new AppError(400, "ERR-VALIDATION", "keywords is required for the 'tag' operation");
      }
      const doc = await Document.findOne({ where: { id: documentId, tenantId: user.tenantId } });
      if (!doc) throw new AppError(404, "ERR-NOT-FOUND", `Document ${documentId} not found`);
      const [meta, created] = await DocumentMetadata.findOrCreate({
        where: { documentId },
        defaults: { documentId, keywords: params.keywords },
      });
      if (!created) {
        await meta.update({ keywords: params.keywords });
      }
      await enqueueWebsocketEvent("DOCUMENT.UPDATED", {
        documentId,
        change: "tag",
        departmentId: doc.departmentId,
        tenantId: user.tenantId,
      });
      return;
    }

    case "grant-acl": {
      if (!params.principalType || !params.principalId || !params.permission) {
        throw new AppError(400, "ERR-VALIDATION", "principalType, principalId, and permission are required for 'grant-acl'");
      }
      await createAclEntry(
        "document",
        documentId,
        {
          principalType: params.principalType,
          principalId: params.principalId,
          effect: params.effect ?? "ALLOW",
          permission: params.permission,
          expiresAt: params.expiresAt,
        },
        user.userId,
        user.tenantId,
      );
      return;
    }

    default:
      throw new AppError(400, "ERR-VALIDATION", `Unknown operation: ${operation}`);
  }
}

export async function bulkDocumentOperation(
  user: AuthenticatedUser,
  operation: BulkOperation,
  documentIds: string[],
  params: {
    status?: string;
    folderId?: string | null;
    keywords?: string;
    principalType?: "user" | "role";
    principalId?: string;
    effect?: "ALLOW" | "DENY";
    permission?: string;
    expiresAt?: string | null;
  } = {},
) {
  if (!OP_PERMISSION[operation]) {
    throw new AppError(400, "ERR-VALIDATION", `Unknown operation: ${operation}`);
  }
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    throw new AppError(400, "ERR-VALIDATION", "documentIds must be a non-empty array");
  }
  if (documentIds.length > MAX_BATCH) {
    throw new AppError(400, "ERR-VALIDATION", `Batch size exceeds limit of ${MAX_BATCH}`);
  }

  // Operation-level gate (each document is still ACL-checked inside the op).
  if (!userHasPermission({ role: user.role, permissions: user.permissions }, OP_PERMISSION[operation])) {
    throw new AppError(403, "ERR-PERMISSION-DENIED", `Missing permission: ${OP_PERMISSION[operation]}`);
  }

  // De-duplicate while preserving order.
  const ids = Array.from(new Set(documentIds.map(String)));

  const results: BulkResultItem[] = [];
  for (const id of ids) {
    try {
      await applyOne(operation, id, user, params);
      results.push({ documentId: id, success: true });
    } catch (err) {
      results.push({
        documentId: id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof AppError ? err.code : "ERR-UNKNOWN",
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  await writeAuditLog({
    eventType: AUDIT_EVENTS.DOCUMENT_UPDATED,
    userId: user.userId,
    userRole: user.role,
    actionDetails: {
      action: "bulk_operation",
      operation,
      total: ids.length,
      succeeded,
      failed,
      params,
    },
    isSuccess: failed === 0,
  });

  return {
    operation,
    summary: { total: ids.length, succeeded, failed },
    results,
  };
}
