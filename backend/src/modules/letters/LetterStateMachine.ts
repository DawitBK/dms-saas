import { AppError } from '../../core/AppError.js';

// Centralized letter lifecycle — replaces the inline `['A','B'].includes(status)`
// checks that were scattered across letters.service.ts. One source of truth for
// what transitions are legal.
//
// OUTGOING (scanned, or composed with no signing requirement):
//   DRAFT → IN_REVIEW → (RETURNED → IN_REVIEW) → APPROVED → DISPATCHED → ARCHIVED
// OUTGOING, COMPOSED (goes through a real e-signing ceremony — see
//   enterPendingSignatureInTx/finalizeLetterAfterSigning in letters.service.ts):
//   DRAFT → IN_REVIEW → PENDING_SIGNATURE → APPROVED → DISPATCHED → ARCHIVED
// INCOMING: RECEIVED → RESPONDED → CLOSED → ARCHIVED
// Either direction may be CANCELLED from an editable/open state.
//
// FIX (deadlock recovery): IN_REVIEW → CANCELLED is also legal. Without it, a
// chain stuck on a deactivated assignee or an unstaffed role had no recovery
// path once submitted — cancelLetter() only accepted DRAFT/RETURNED. This is
// gated behind an elevated permission + mandatory reason in the service layer
// (mirrors lockService.forceUnlock), not a normal drafter action.
// PENDING_SIGNATURE → CANCELLED is the same recovery path for a signature
// ceremony that never completes (signer left, request expired, etc.).

export const letterStates = [
  'DRAFT', 'IN_REVIEW', 'RETURNED', 'PENDING_SIGNATURE', 'APPROVED', 'DISPATCHED',
  'RECEIVED', 'RESPONDED', 'CLOSED', 'ARCHIVED', 'CANCELLED',
] as const;

export type LetterState = (typeof letterStates)[number];

const transitions: Record<LetterState, LetterState[]> = {
  DRAFT: ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW: ['APPROVED', 'PENDING_SIGNATURE', 'RETURNED', 'CANCELLED'],
  RETURNED: ['IN_REVIEW', 'CANCELLED'],
  PENDING_SIGNATURE: ['APPROVED', 'CANCELLED'],
  // CANCELLED only while the letter is approved but unnumbered/unsigned (L17); cancelLetter refuses a
  // numbered letter of record.
  APPROVED: ['DISPATCHED', 'ARCHIVED', 'CANCELLED'],
  DISPATCHED: ['ARCHIVED'],
  RECEIVED: ['RESPONDED', 'CLOSED', 'ARCHIVED'],
  RESPONDED: ['CLOSED', 'ARCHIVED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
};

/** States from which a drafter may still edit / submit / cancel the letter. */
export const EDITABLE_STATES: LetterState[] = ['DRAFT', 'RETURNED'];

export function canTransition(from: string, to: string): boolean {
  const allowed = transitions[from as LetterState];
  return Boolean(allowed && allowed.includes(to as LetterState));
}

export function assertTransition(from: string, to: string): void {
  if (!letterStates.includes(from as LetterState) || !letterStates.includes(to as LetterState))
    throw new AppError(422, 'ERR-LETTER-STATE-UNKNOWN', `Unknown letter state: ${from} -> ${to}`);
  if (from !== to && !canTransition(from, to))
    throw new AppError(409, 'ERR-LETTER-STATE-INVALID', `Invalid letter transition: ${from} -> ${to}`);
}
