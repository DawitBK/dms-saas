// Letters E27 — a declined / voided / expired signing request must not strand the letter.
//
// initiateLetterSigning files a signable draft, moves the letter APPROVED -> PENDING_SIGNATURE and
// creates one e-signing request. If the signer declines, the requester voids it, or it expires, the
// e-signing module closes the request (and the draft document) but knows nothing about letters, so the
// letter stayed in PENDING_SIGNATURE with no live request; only an admin cancel recovered it, which
// throws the approved letter away.
//
// Recovery here: PENDING_SIGNATURE -> APPROVED (the state before signing was initiated: approval is
// complete, no reference number, no document of record), so the drafter or an approver can start signing
// again with the same or another signatory. The closed request's draft is kept (renamed so the
// per-tenant unique document name is free for the next draft) and the reason is audited.
//
// Two ways in, neither of which needs a change inside modules/esigning:
//   1. reconcileLetterSigning(letterId): looks at the letter's own signing request and recovers it if
//      that request is closed. Called whenever a PENDING_SIGNATURE letter is read (getLetter /
//      listLetters), so the state is repaired the first time anyone looks at it.
//   2. recoverLetterAfterSigningClosed(documentId, reason): eager variant for the e-signing module to
//      call at the moment it closes a request (decline, cancel, expiry sweep). See the report: those
//      are the one-line calls the e-sign owner can add; until then (1) covers every case.

import { Op } from 'sequelize';
import { logger } from '../../core/logger.js';
import { Document, Letter, SignatureRequest } from '../../infrastructure/database/index.js';
import { enqueueWebsocketEvent } from '../../infrastructure/queue/outbox.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { fanOut } from '../notifications/notifications.service.js';
import { runInSavepoint, runInTransaction } from '../../shared/transaction.js';
import { registerCeremonyEndedHandler } from '../esigning/esigning.events.js';
import { LETTER_DRAFT_NAME_PREFIX, syncLetterDocumentAcl } from './letterDocumentAcl.js';

const LIVE_OR_PENDING_REQUEST = ['draft', 'sent', 'partially_signed'];
const CLOSED_REQUEST = ['voided', 'expired'];

export type SigningRecoveryResult = { recovered: boolean; requestId?: string; requestStatus?: string };

export async function reconcileLetterSigning(letterId: string, reasonHint?: string): Promise<SigningRecoveryResult> {
  const outcome = await runInTransaction(async (tx): Promise<
    SigningRecoveryResult & { letter?: Letter; reason?: string; previousSignatory?: string | null; draftDocumentId?: string }
  > => {
    const locked = await Letter.findOne({
      where: { id: letterId, status: 'PENDING_SIGNATURE' },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!locked || !locked.documentId) return { recovered: false };

    const requests = await SignatureRequest.findAll({
      where: { documentId: locked.documentId },
      order: [['createdAt', 'DESC']],
      transaction: tx,
    });
    // Anything still open (including a draft not yet sent) means the ceremony is alive; a completed
    // request is finalising the letter on the e-signing side. Only a closed newest request recovers.
    if (requests.length === 0 || requests.some((r) => LIVE_OR_PENDING_REQUEST.includes(r.status))) return { recovered: false };
    const latest = requests[0]!;
    if (!CLOSED_REQUEST.includes(latest.status)) return { recovered: false };

    const reason = reasonHint ?? latest.voidedReason ?? `Signing request ${latest.status}`;
    const draftDocumentId = locked.documentId;
    const previousSignatory = locked.signatoryName;

    // Free the unique `Letter draft — <id>` name for the next draft; keep the closed one traceable.
    await Document.update(
      { documentName: `${LETTER_DRAFT_NAME_PREFIX}${locked.id} (closed ${latest.id.slice(0, 8)})` },
      { where: { id: draftDocumentId }, transaction: tx },
    );
    await locked.update(
      {
        status: 'APPROVED',
        documentId: null,
        signatoryUserId: null,
        signatoryName: null,
        signatoryTitle: null,
        assignedSignatoryUserId: null,
        assignedSignatoryRole: null,
      },
      { transaction: tx },
    );
    // The signatory (if any) is no longer a participant: tighten a restricted letter's documents again.
    await syncLetterDocumentAcl(locked.id, locked.tenantId, tx);
    return { recovered: true, requestId: latest.id, requestStatus: latest.status, letter: locked, reason, previousSignatory, draftDocumentId };
  });

  if (!outcome.recovered || !outcome.letter) return { recovered: false };
  const letter = outcome.letter;

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_UPDATED,
    tenantId: letter.tenantId,
    userId: null,
    documentId: outcome.draftDocumentId ?? null,
    actionDetails: {
      letterId: letter.id,
      action: 'signing-request-closed',
      from: 'PENDING_SIGNATURE',
      to: 'APPROVED',
      requestId: outcome.requestId,
      requestStatus: outcome.requestStatus,
      reason: outcome.reason,
      previousSignatory: outcome.previousSignatory ?? null,
    },
  }).catch((err) => logger.warn({ err, letterId: letter.id }, '[letters] failed to audit signing recovery'));
  await enqueueWebsocketEvent('LETTER.APPROVED', {
    tenantId: letter.tenantId, departmentId: letter.departmentId, letterId: letter.id, subject: letter.subject,
  }).catch(() => undefined);
  // Same notification as "approval complete, signature required": the drafter has to start signing again.
  await fanOut({
    type: 'LETTER_APPROVED',
    tenantId: letter.tenantId,
    recipientIds: [letter.createdBy],
    severity: 'WARNING',
    payload: { letterId: letter.id, subject: letter.subject, awaitingSigningInitiation: true, signingRequestClosed: true, reason: outcome.reason },
  }).catch(() => undefined);
  return { recovered: true, requestId: outcome.requestId, requestStatus: outcome.requestStatus };
}

/** Eager hook for the e-signing module: call it right after a request is declined, cancelled or expired. */
export async function recoverLetterAfterSigningClosed(documentId: string, reason?: string): Promise<SigningRecoveryResult> {
  const letter = await Letter.findOne({ where: { documentId, status: 'PENDING_SIGNATURE' }, attributes: ['id'] });
  if (!letter) return { recovered: false };
  return reconcileLetterSigning(letter.id, reason);
}

/** Repair every PENDING_SIGNATURE letter the caller's tenant context can see. Returns how many recovered. */
export async function reconcilePendingSignatureLetters(): Promise<number> {
  const pending = await Letter.findAll({ where: { status: 'PENDING_SIGNATURE', documentId: { [Op.ne]: null } }, attributes: ['id'] });
  let count = 0;
  for (const l of pending) if ((await reconcileLetterSigning(l.id)).recovered) count += 1;
  return count;
}

// Eager recovery (E27): the e-signing module announces every declined, cancelled or expired ceremony in the
// SAME transaction that closes it, so the letter returns to APPROVED at that moment rather than on the next
// read. Its own savepoint keeps a failure here from aborting (and rolling back) the decline, cancel or expiry
// itself; reconcileLetterSigning on read stays as the backstop. This module is imported by the API process
// through letters.service and by the worker through EsigningExpiryWorker, the two processes that can end one.
registerCeremonyEndedHandler(async (event) => {
  try {
    await runInSavepoint(() => recoverLetterAfterSigningClosed(event.documentId, event.reason ?? `Signing request ${event.outcome}`));
  } catch (err) {
    logger.warn({ err, documentId: event.documentId, outcome: event.outcome }, '[letters] eager signing recovery failed — it will be repaired when the letter is next read');
  }
});
