/**
 * Signing-ceremony lifecycle hook (E27).
 *
 * A signature request can end without being signed: a recipient declines, the
 * requester cancels it, or it expires. Other modules that wait on a ceremony
 * (letters: a letter parked in PENDING_SIGNATURE) need to react to that — before
 * this hook, a declined ceremony left the letter in PENDING_SIGNATURE with no live
 * request and only an administrator's cancel recovered it.
 *
 * HOW A MODULE USES IT
 *
 *   import { registerCeremonyEndedHandler } from '../esigning/esigning.events.js';
 *   registerCeremonyEndedHandler(async (event, tx) => { ... });
 *
 * Contract:
 *  - The handler is awaited INSIDE the same database transaction that voids/expires
 *    the request (decline, cancel, expiry — each runs its status change and the
 *    handler in one transaction). Pass `tx` to every query the handler makes, and
 *    let errors propagate: a throwing handler rolls the whole decline/cancel/expiry
 *    back, so the request and the thing waiting on it can never disagree.
 *  - It is called once per ended request, with `outcome` of `declined`, `cancelled`
 *    or `expired`. It is NOT called for a request that completes (the signed path
 *    keeps its own finaliser) nor for the documents module's silent voids (trash,
 *    new-version supersede), which already move the document themselves.
 *  - Handlers must be idempotent and must only act on what they own (look the thing
 *    up by `documentId`; do nothing when there is none).
 *  - Registration is a module-level side effect, so the module that registers must be
 *    imported in EVERY process that can end a ceremony: the API process (decline,
 *    cancel) and the worker process (EsigningExpiryWorker). Importing it from the
 *    module that owns the waiting state (e.g. letters.service.ts) covers the API; the
 *    worker entry must import it too, or an expiry will not reach the handler.
 *    `expireSignatureRequests()` logs a warning when it ends a request while no
 *    handler is registered, which is how a missing worker import shows up.
 */

import type { Transaction } from 'sequelize';

export type CeremonyOutcome = 'declined' | 'cancelled' | 'expired';

export interface CeremonyEndedEvent {
  requestId: string;
  documentId: string;
  tenantId: string;
  outcome: CeremonyOutcome;
  /** The decline / cancel reason; null for an expiry or when none was given. */
  reason: string | null;
  /** Who ended it: the declining internal user, the canceller; null for an external signer or the expiry sweep. */
  actorUserId: string | null;
  /** The declining recipient (declines only). */
  recipientId: string | null;
}

export type CeremonyEndedHandler = (event: CeremonyEndedEvent, tx?: Transaction) => Promise<void> | void;

const handlers: CeremonyEndedHandler[] = [];

/** Registers a handler; returns an unregister function (used by tests). */
export function registerCeremonyEndedHandler(handler: CeremonyEndedHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** True when at least one module is listening (the expiry sweep warns when not). */
export function hasCeremonyEndedHandlers(): boolean {
  return handlers.length > 0;
}

/** Runs every registered handler in order, awaiting each. Errors propagate to the caller's transaction. */
export async function emitCeremonyEnded(event: CeremonyEndedEvent, tx?: Transaction): Promise<void> {
  for (const handler of [...handlers]) {
    await handler(event, tx);
  }
}
