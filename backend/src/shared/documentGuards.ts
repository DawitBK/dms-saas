// SPRINT-4/5: keep these guards aligned with ACL, legal hold, and terminal-state enforcement.
import { AppError } from "../core/AppError.js";
import { PERMISSIONS, userHasPermission } from "../config/permissions.js";

export type GuardDocument = {
  id: string;
  tenantId?: string;
  ownerId: string;
  departmentId: string;
  status: string;
  isOnLegalHold: boolean;
  securityClassification: string;
  checkout?: { checkedOutBy: string } | null;
};

export type GuardUser = {
  userId: string;
  role: string;
  tenantId: string;
  // Effective permission union across ALL of the user's assigned roles
  // (AuthenticatedUser.permissions). Optional only so unit tests can build a
  // bare GuardUser; every real caller passes req.user, which always has it.
  permissions?: readonly string[];
};

const terminalStates = new Set(["DISPOSED", "PRESERVED", "CANCELLED"]);

export function requireDocumentAccess(document: GuardDocument, user: GuardUser) {
  // Tenant isolation is absolute — it applies BEFORE any permission check.
  // A document from another tenant is treated as nonexistent (404, not 403),
  // so tenant B can't even confirm a tenant-A document id is valid.
  if (document.tenantId && document.tenantId !== user.tenantId) {
    throw new AppError(404, "ERR-DOCUMENT-NOT-FOUND", "Document not found");
  }

  // §1: permission-based — users with DOCUMENT_READ_ALL can access any document
  // within their tenant. Checked against the user's full permission UNION
  // (all assigned roles), not the bare display role: `role` is the single
  // highest-ranked role for UI only (see auth.ts) — a user holding both
  // EMPLOYEE and a custom role that grants DOCUMENT_READ_ALL would otherwise
  // have that grant silently ignored because EMPLOYEE outranks it for display.
  if (userHasPermission({ role: user.role, permissions: user.permissions as never }, PERMISSIONS.DOCUMENT_READ_ALL)) return;

  // Department-scope enforcement is handled by resolveACL (folder + department
  // ancestry, DENY-first) on the routes that carry requireACL.
}

export function requireLegalHoldClear(document: GuardDocument) {
  if (document.isOnLegalHold) {
    throw new AppError(403, "ERR-HOLD-MODIFICATION-BLOCKED", "Document is under legal hold");
  }
}

export function assertNotTerminalState(document: GuardDocument) {
  if (terminalStates.has(document.status)) {
    throw new AppError(409, "ERR-DOCUMENT-TERMINAL", "Document is in a terminal state");
  }
}

/**
 * Reject any mutation of a trashed document. TRASHED is deliberately NOT a
 * terminal state (restore returns the document to its pre-trash position), so
 * assertNotTerminalState does not cover it — but a soft-deleted document that is
 * scheduled for certified destruction must not accept new versions, rollbacks or
 * check-outs. Without this a checkout/lock that survived trashing let content be
 * mutated on a purge-pending row (S19 audit finding). Guards on both the status
 * and the deletedAt flag so either signal is sufficient.
 */
export function assertNotTrashed(document: Pick<GuardDocument, "status"> & { deletedAt?: Date | null }) {
  if (document.status === "TRASHED" || document.deletedAt) {
    throw new AppError(409, "ERR-DOCUMENT-TRASHED", "Document is in the trash; restore it first");
  }
}

export function requireCheckoutOwner(document: GuardDocument, user: GuardUser) {
  if (document.checkout?.checkedOutBy !== user.userId) {
    throw new AppError(403, "ERR-CHECKOUT-OWNER-REQUIRED", "Document must be checked out by the current user");
  }
}

/**
 * STOR-1: files over the async-scan threshold (documents.service.ts's
 * ASYNC_SCAN_THRESHOLD, 100MB) are created in SCAN_PENDING with
 * avScanStatus 'unscanned' and only promoted to DRAFT/ACTIVE/QUARANTINED
 * once ScanWorker actually runs ClamAV against the decrypted bytes — but
 * nothing blocked reading the file in the meantime. The generic
 * status-permission system (statusPermissions.service.ts) is deliberately
 * narrow-only/absence-means-unrestricted (so it can't silently shadow a
 * future default the way role_permissions once did), so a default-deny rule
 * does not belong there; this is a dedicated guard instead, the same shape
 * as requireLegalHoldClear/assertNotTrashed above. SCAN_PENDING is the
 * authoritative, single signal — ScanWorker's success/failure/threat paths
 * all move the document out of it as their very first write.
 */
export function assertScanCleared(document: GuardDocument) {
  if (document.status === "SCAN_PENDING") {
    throw new AppError(
      409,
      "ERR-DOCUMENT-SCAN-PENDING",
      "This file is still being scanned for malware and is not yet available",
    );
  }
  // A virus was found: ScanWorker moved the ciphertext to the quarantine prefix.
  // Without this the download/preview of a quarantined document fell through to a
  // storage "not found" 500 (and, if the object were ever restored, would serve
  // the infected bytes to anyone with read access).
  if (document.status === "QUARANTINED") {
    throw new AppError(
      409,
      "ERR-DOCUMENT-QUARANTINED",
      "This file was quarantined because malware was detected in it and cannot be opened",
    );
  }
}
