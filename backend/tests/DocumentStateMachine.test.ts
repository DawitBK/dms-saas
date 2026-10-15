import { AppError } from "../src/core/AppError.js";
import {
  documentStates,
  validateTransition,
  requiredPermissionForManualTransition,
  type DocumentState,
} from "../src/modules/documents/DocumentStateMachine.js";

const validTransitions: Array<[DocumentState, DocumentState]> = [
  ["DRAFT", "PENDING_REVIEW"],
  // Owner discards a draft they never submitted (documents.service.ts's
  // manual status endpoint, MANUAL_TRANSITION_PERMISSIONS["DRAFT->CANCELLED"]).
  ["DRAFT", "CANCELLED"],
  // Owner-driven publish for document types that opt out of approval
  // (DocumentType.requiresApproval = false) — graph-valid so publishDraft can
  // reuse validateTransition, but deliberately absent from
  // MANUAL_TRANSITION_PERMISSIONS so the generic manual endpoint can't use it
  // (see the C2 note in DocumentStateMachine.ts).
  ["DRAFT", "ACTIVE"],
  ["PENDING_REVIEW", "IN_REVIEW"],
  ["IN_REVIEW", "APPROVED"],
  ["IN_REVIEW", "REJECTED"],
  ["IN_REVIEW", "ON_HOLD"],
  ["ON_HOLD", "IN_REVIEW"],
  ["ON_HOLD", "CANCELLED"],
  ["REJECTED", "DRAFT"],
  ["REJECTED", "CANCELLED"],
  ["APPROVED", "PENDING_SIGNATURE"],
  ["APPROVED", "ACTIVE"],
  ["PENDING_SIGNATURE", "SIGNED"],
  ["PENDING_SIGNATURE", "SIGNING_DECLINED"],
  ["SIGNING_DECLINED", "PENDING_SIGNATURE"],
  ["SIGNING_DECLINED", "CANCELLED"],
  ["SIGNED", "ACTIVE"],
  ["ACTIVE", "ARCHIVED"],
  ["ACTIVE", "SUPERSEDED"],
  ["SUPERSEDED", "ARCHIVED"],
  ["ARCHIVED", "LEGAL_HOLD"],
  ["ARCHIVED", "DISPOSAL_PENDING"],
  ["ARCHIVED", "PRESERVED"],
  // Activate action (documents.service.ts's activateDocument): a document
  // filed to ARCHIVED — now the default terminal state after approval — can
  // be brought back live if it's needed again.
  ["ARCHIVED", "ACTIVE"],
  ["LEGAL_HOLD", "ARCHIVED"],
  ["DISPOSAL_PENDING", "DISPOSED"]
];

describe("DocumentStateMachine", () => {
  it.each(validTransitions)("allows %s -> %s", (from, to) => {
    expect(() => validateTransition(from, to)).not.toThrow();
  });

  it("rejects terminal state transitions", () => {
    for (const state of ["DISPOSED", "PRESERVED", "CANCELLED"] as DocumentState[]) {
      for (const target of documentStates) {
        expect(() => validateTransition(state, target)).toThrow(AppError);
      }
    }
  });

  it("rejects invalid lifecycle jumps", () => {
    expect(() => validateTransition("DRAFT", "APPROVED")).toThrow(AppError);
    // ARCHIVED -> ACTIVE is the Activate action and is valid (see
    // validTransitions above); ARCHIVED -> IN_REVIEW is not a real edge.
    expect(() => validateTransition("ARCHIVED", "IN_REVIEW")).toThrow(AppError);
    expect(() => validateTransition("PENDING_REVIEW", "APPROVED")).toThrow(AppError);
  });

  // C2: DRAFT -> ACTIVE is graph-valid (so publishDraft can reuse
  // validateTransition for its own, narrowly-scoped opt-out check) but must
  // stay unreachable via the generic manual status endpoint, or any
  // document:upload holder could self-publish an approval-required document
  // by hand, bypassing the chain entirely.
  it("keeps DRAFT -> ACTIVE off the generic manual-transition allowlist", () => {
    expect(requiredPermissionForManualTransition("DRAFT", "ACTIVE")).toBeNull();
  });
});
