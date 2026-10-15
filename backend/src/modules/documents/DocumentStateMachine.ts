import { AppError } from "../../core/AppError.js";

export const documentStates = [
  "DRAFT",
  // Large uploads (>100 MB) await an async virus scan before becoming a
  // normal DRAFT; documents are *created* in this state (no inbound
  // transition) and promoted by the ScanWorker.
  "SCAN_PENDING",
  "PENDING_REVIEW",
  "IN_REVIEW",
  "ON_HOLD",
  "REJECTED",
  // Unified approval engine (SYSTEM-DECISIONS.md D3/D4): bounced back to the
  // author with the chain suspended / hard-rejected but revisable.
  "CHANGES_REQUESTED",
  "DECLINED",
  "APPROVED",
  // Audit stage (SYSTEM-DECISIONS.md D5–D7): sits between approval-complete
  // and archive. FLAG returns the item to the final approver (AUDIT_FLAGGED)
  // for remediation; after fixes it re-enters PENDING_AUDIT.
  "PENDING_AUDIT",
  "AUDITED",
  "AUDIT_FLAGGED",
  "PENDING_SIGNATURE",
  "SIGNING_DECLINED",
  "SIGNED",
  "ACTIVE",
  "SUPERSEDED",
  "ARCHIVED",
  "LEGAL_HOLD",
  "DISPOSAL_PENDING",
  "DISPOSED",
  "PRESERVED",
  "CANCELLED",
  "TRASHED",
  "QUARANTINED"
] as const;

export type DocumentState = (typeof documentStates)[number];

const transitions: Record<DocumentState, DocumentState[]> = {
  // DRAFT → IN_REVIEW is the unified engine's self-service submit (D1);
  // DRAFT → PENDING_REVIEW remains for the legacy workflow module.
  // DRAFT → CANCELLED lets an owner discard a draft they never submitted
  // (MANUAL_TRANSITION_PERMISSIONS already mapped this to document:upload;
  // it was unreachable until this edge existed). DRAFT → ACTIVE is graph-valid
  // for the same reason APPROVED → ACTIVE is (so publishDraft can reuse
  // validateTransition), but is intentionally absent from
  // MANUAL_TRANSITION_PERMISSIONS below — it is only reachable through the
  // dedicated publishDraft() function, which gates it on the document type
  // having opted out of approval, not through the generic manual-status
  // endpoint (see the C2 note below for why that distinction matters).
  DRAFT: ["PENDING_REVIEW", "IN_REVIEW", "CANCELLED", "ACTIVE"],
  SCAN_PENDING: ["DRAFT", "QUARANTINED", "CANCELLED"],
  PENDING_REVIEW: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "REJECTED", "ON_HOLD", "CHANGES_REQUESTED", "DECLINED"],
  ON_HOLD: ["IN_REVIEW", "CANCELLED"],
  REJECTED: ["DRAFT", "CANCELLED"],
  CHANGES_REQUESTED: ["IN_REVIEW", "CANCELLED"],
  // D3: DECLINED is revisable — the author may edit and resubmit (fresh chain).
  DECLINED: ["IN_REVIEW", "CANCELLED"],
  APPROVED: ["PENDING_SIGNATURE", "PENDING_AUDIT", "ACTIVE", "ARCHIVED"],
  PENDING_SIGNATURE: ["SIGNED", "SIGNING_DECLINED"],
  SIGNING_DECLINED: ["PENDING_SIGNATURE", "CANCELLED"],
  SIGNED: ["ACTIVE", "PENDING_AUDIT", "ARCHIVED"],
  PENDING_AUDIT: ["AUDITED", "AUDIT_FLAGGED"],
  AUDITED: ["ARCHIVED", "ACTIVE"],
  AUDIT_FLAGGED: ["PENDING_AUDIT", "CANCELLED"],
  // ACTIVE → PENDING_SIGNATURE: a published/live document can still be sent
  // for e-signing (esigning.service.ts's createSignatureRequest already
  // treats ACTIVE as signable) — e.g. re-signing an already-active document,
  // or a signing request created after the document was published rather
  // than before. Subsystem-only (esigning's sendSignatureRequest), so
  // intentionally absent from MANUAL_TRANSITION_PERMISSIONS below.
  ACTIVE: ["ARCHIVED", "SUPERSEDED", "PENDING_SIGNATURE"],
  SUPERSEDED: ["ARCHIVED"],
  // ARCHIVED -> ACTIVE: the "Activate" action (documents.service.ts's
  // activateDocument, mirroring archiveDocument) — a document that reached
  // ARCHIVED as its default terminal clearance state can be brought back
  // live if it's needed again, same permission as archiving it.
  ARCHIVED: ["LEGAL_HOLD", "DISPOSAL_PENDING", "PRESERVED", "ACTIVE"],
  LEGAL_HOLD: ["ARCHIVED"],
  DISPOSAL_PENDING: ["DISPOSED"],
  DISPOSED: [],
  PRESERVED: [],
  CANCELLED: [],
  // TRASHED is reachable from any non-terminal state (soft delete); restore
  // returns the document to its pre-trash status (handled in trashService).
  TRASHED: ["DRAFT", "ACTIVE", "ARCHIVED", "IN_REVIEW", "APPROVED", "CANCELLED"],
  QUARANTINED: ["ACTIVE", "CANCELLED"]
};

export function validateTransition(fromState: string, toState: string) {
  if (!documentStates.includes(fromState as DocumentState) || !documentStates.includes(toState as DocumentState)) {
    throw new AppError(422, "ERR-DOCUMENT-STATE-UNKNOWN", "Unknown document state");
  }

  const allowed = transitions[fromState as DocumentState];
  if (!allowed.includes(toState as DocumentState)) {
    throw new AppError(409, "ERR-DOCUMENT-STATE-INVALID", `Invalid document transition: ${fromState} -> ${toState}`);
  }
}

/**
 * Per-transition authorization for the MANUAL status endpoint (PATCH /:id/status)
 * and bulk status changes. This is a strict allowlist keyed "FROM->TO":
 *
 *  - A transition present here requires the mapped permission.
 *  - A transition ABSENT here is refused on the manual endpoint entirely, because
 *    it is driven by a subsystem that updates status itself (approval engine,
 *    audit stage, e-signing, legal hold, disposal worker). This is the fix for
 *    C2: without it, a holder of only `document:upload` could walk a document
 *    DRAFT -> IN_REVIEW -> APPROVED -> ARCHIVED by hand, self-approving and
 *    bypassing the entire approval chain.
 *
 * The permission values are the string forms from config/permissions.ts.
 */
export const MANUAL_TRANSITION_PERMISSIONS: Record<string, string> = {
  // Publish / archive an already-approved (and, where required, audited) doc.
  "APPROVED->ACTIVE": "document:archive",
  "APPROVED->ARCHIVED": "document:archive",
  "SIGNED->ACTIVE": "document:archive",
  "SIGNED->ARCHIVED": "document:archive",
  "AUDITED->ACTIVE": "document:archive",
  "AUDITED->ARCHIVED": "document:archive",
  "ACTIVE->ARCHIVED": "document:archive",
  "ACTIVE->SUPERSEDED": "version:manage",
  "SUPERSEDED->ARCHIVED": "document:archive",
  // Reactivate an archived document — the reverse of the archive action above.
  "ARCHIVED->ACTIVE": "document:archive",
  // Records lifecycle after archive → retention manager territory.
  "ARCHIVED->DISPOSAL_PENDING": "retention:manage",
  "ARCHIVED->PRESERVED": "retention:manage",
  // Quarantine resolution (records officer / admin).
  "QUARANTINED->ACTIVE": "document:archive",
  "QUARANTINED->CANCELLED": "document:archive",
  // Author-side housekeeping on non-approved states.
  "DRAFT->CANCELLED": "document:upload",
  "REJECTED->DRAFT": "document:upload",
  "REJECTED->CANCELLED": "document:archive",
  "ON_HOLD->CANCELLED": "document:archive",
};

/**
 * Returns the permission required to perform `from->to` via the manual endpoint,
 * or `null` if the transition is not permitted manually at all (subsystem-only).
 */
export function requiredPermissionForManualTransition(fromState: string, toState: string): string | null {
  return MANUAL_TRANSITION_PERMISSIONS[`${fromState}->${toState}`] ?? null;
}
