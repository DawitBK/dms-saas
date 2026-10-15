// Letters L14 — a letter's backing documents follow the letter's own classification.
//
// A letter's final PDF, signable draft, cover sheet, scan and attachments are ordinary `documents`
// rows, and grantDefaultDocumentAcl gives every CURRENT member of the department a read snapshot.
// For a CONFIDENTIAL or RESTRICTED letter that defeated the rule letters themselves apply
// (scopeWhere: participants only): any department member could open the documents through the
// Documents module. This file makes the document ACL match:
//
//   * CONFIDENTIAL / RESTRICTED: no department snapshot. Readers are the owner, the letter's
//     participants (drafter, incoming assignee, signatory, named step assignees and deciders, holders of a
//     still-open role step or of the signatory role in the letter's department), each with a DELIBERATE
//     per-user read grant (origin NULL, so it is honoured outside the department), plus everyone who
//     holds document:read_all / acl:bypass_admin, which never needed a row.
//   * Anything else: the ordinary department snapshot.
//
// `syncLetterDocumentAcl` re-applies the rule to every backing document of an existing letter; it runs
// when the classification changes and whenever the participant set changes (submit, reassign, signing).

import { Op, type Transaction } from 'sequelize';
import {
  AclEntry,
  Document,
  Letter,
  LetterApprovalStep,
  LetterAttachment,
  UserDepartment,
} from '../../infrastructure/database/index.js';
import { resolveRoleUserIds } from '../../shared/assignmentAdvisory.js';
import { grantDefaultDocumentAcl } from '../documents/documents.service.js';

/** Classifications whose documents are readable by participants and oversight holders only. */
export const PARTICIPANTS_ONLY_CLASSES = ['CONFIDENTIAL', 'RESTRICTED'] as const;

export function isParticipantsOnly(confidentiality: string | null | undefined): boolean {
  return PARTICIPANTS_ONLY_CLASSES.includes(confidentiality as (typeof PARTICIPANTS_ONLY_CLASSES)[number]);
}

/** acl_entries.origin of a read grant this module wrote for a letter participant. */
export const PARTICIPANT_ORIGIN = 'LETTER_PARTICIPANT';

/** The signable draft is filed as `Letter draft — <letterId>` (renamed with a suffix when its ceremony
 *  is closed, see letterSigningRecovery.ts), so drafts can be found from the letter id alone. */
export const LETTER_DRAFT_NAME_PREFIX = 'Letter draft — ';

type ParticipantSource = {
  id: string;
  tenantId: string;
  departmentId: string | null;
  createdBy: string;
  assignedToUserId?: string | null;
  signatoryUserId?: string | null;
  assignedSignatoryUserId?: string | null;
  assignedSignatoryRole?: string | null;
};

/** Everyone who is on the letter and therefore may read its documents. */
export async function collectLetterParticipantIds(letter: ParticipantSource, tx?: Transaction): Promise<string[]> {
  const ids = new Set<string>([letter.createdBy]);
  for (const id of [letter.assignedToUserId, letter.signatoryUserId, letter.assignedSignatoryUserId]) {
    if (id) ids.add(id);
  }
  const steps = await LetterApprovalStep.findAll({
    where: { letterId: letter.id, status: { [Op.in]: ['WAITING', 'PENDING', 'APPROVED', 'RETURNED'] } },
    attributes: ['assignedUserId', 'assignedRole', 'status', 'decidedBy', 'escalatedToUserIds'],
    transaction: tx,
  });
  const roles = new Set<string>();
  if (letter.assignedSignatoryRole) roles.add(letter.assignedSignatoryRole);
  for (const step of steps) {
    if (step.assignedUserId) ids.add(step.assignedUserId);
    if (step.decidedBy) ids.add(step.decidedBy);
    if (step.status === 'PENDING') for (const id of step.escalatedToUserIds ?? []) ids.add(id);
    if (step.assignedRole && !step.assignedUserId && (step.status === 'PENDING' || step.status === 'WAITING')) {
      roles.add(step.assignedRole);
    }
  }
  for (const role of roles) {
    for (const id of await resolveRoleUserIds(role, letter.tenantId, letter.departmentId)) ids.add(id);
  }
  return [...ids];
}

async function grantDeliberateReads(
  tenantId: string,
  documentIds: string[],
  userIds: string[],
  grantedById: string,
  tx?: Transaction,
) {
  const rows = documentIds.flatMap((resourceId) =>
    userIds.map((principalId) => ({
      tenantId, resourceType: 'document' as const, resourceId,
      principalType: 'user' as const, principalId,
      effect: 'ALLOW' as const, permission: 'document:read', grantedById,
      // Deliberate (not DEPT_SNAPSHOT), so honoured outside the department; the distinct origin lets a
      // later sync withdraw exactly these rows when someone stops being a participant.
      origin: PARTICIPANT_ORIGIN,
    })),
  );
  if (rows.length > 0) await AclEntry.bulkCreate(rows, { transaction: tx, ignoreDuplicates: true });
}

async function invalidateAfter(tx: Transaction | undefined, tenantId: string, documentIds: string[]) {
  const run = async () => {
    // Dynamic import: aclCache pulls in Redis config at module load, which the letters unit tests
    // (minimal mocked config) cannot construct. Same device as letterBodyImages.service.ts.
    const { invalidateResourceACL } = await import('../../infrastructure/cache/aclCache.js');
    for (const id of documentIds) await invalidateResourceACL(tenantId, 'document', id).catch(() => undefined);
  };
  if (tx && typeof tx.afterCommit === 'function') tx.afterCommit(() => { void run(); });
  else await run();
}

/**
 * Grant the ACL of a freshly created letter document. Replaces the bare grantDefaultDocumentAcl calls.
 * `participantIds` are the people on the letter at this moment (callers that have the letter row pass
 * collectLetterParticipantIds; callers that create the document before the row exists pass what they know).
 */
export async function grantLetterDocumentAcl(
  args: {
    documentId: string;
    ownerId: string;
    tenantId: string;
    departmentId: string;
    confidentiality: string | null | undefined;
    participantIds?: string[];
  },
  tx?: Transaction,
): Promise<void> {
  const restricted = isParticipantsOnly(args.confidentiality);
  await grantDefaultDocumentAcl(args.documentId, args.ownerId, args.tenantId, args.departmentId, tx, {
    withholdDepartmentSnapshot: restricted,
  });
  if (restricted) {
    const readers = (args.participantIds ?? []).filter((id) => id !== args.ownerId);
    await grantDeliberateReads(args.tenantId, [args.documentId], readers, args.ownerId, tx);
  }
}

/** Every document that belongs to the letter (current, staged, attachments, cover sheet, signed or voided drafts). */
export async function listLetterDocumentIds(
  letter: Pick<Letter, 'id' | 'tenantId' | 'documentId' | 'attachmentDocumentId' | 'coverSheetDocumentId' | 'signedDraftDocumentId'>,
  tx?: Transaction,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const id of [letter.documentId, letter.attachmentDocumentId, letter.coverSheetDocumentId, letter.signedDraftDocumentId]) {
    if (id) ids.add(id);
  }
  const attachments = await LetterAttachment.findAll({ where: { letterId: letter.id }, attributes: ['documentId'], transaction: tx });
  for (const a of attachments) ids.add(a.documentId);
  const drafts = await Document.findAll({
    where: { tenantId: letter.tenantId, documentName: { [Op.like]: `${LETTER_DRAFT_NAME_PREFIX}${letter.id}%` } },
    attributes: ['id'],
    transaction: tx,
  });
  for (const d of drafts) ids.add(d.id);
  return [...ids];
}

/**
 * Re-apply the letter's classification rule to all of its backing documents. Idempotent.
 *  - participants-only class: department snapshot rows are removed, participants get deliberate reads.
 *  - any other class: nothing, unless `classificationChanged` (e.g. CONFIDENTIAL -> INTERNAL), in which case
 *    the department snapshot is restored so the letter is as visible as a letter of that class always was.
 * The document rows' securityClassification is kept equal to the letter's.
 */
export async function syncLetterDocumentAcl(
  letterId: string,
  tenantId: string,
  tx?: Transaction,
  options: { classificationChanged?: boolean } = {},
): Promise<void> {
  const letter = await Letter.findOne({ where: { id: letterId, tenantId }, transaction: tx });
  if (!letter) return;
  const restricted = isParticipantsOnly(letter.confidentiality);
  if (!restricted && !options.classificationChanged) return;

  const documentIds = await listLetterDocumentIds(letter, tx);
  if (documentIds.length === 0) return;

  if (options.classificationChanged) {
    await Document.update(
      { securityClassification: letter.confidentiality },
      { where: { id: { [Op.in]: documentIds }, tenantId }, transaction: tx },
    );
  }

  if (restricted) {
    await AclEntry.destroy({
      where: { tenantId, resourceType: 'document', resourceId: { [Op.in]: documentIds }, origin: 'DEPT_SNAPSHOT' },
      transaction: tx,
    });
    const participants = await collectLetterParticipantIds(letter, tx);
    // Withdraw the grants this module wrote for people who are no longer on the letter (a cancelled or
    // reassigned step, a replaced signatory). Grants from anywhere else (origin NULL) are never touched.
    await AclEntry.destroy({
      where: {
        tenantId, resourceType: 'document', resourceId: { [Op.in]: documentIds }, origin: PARTICIPANT_ORIGIN,
        principalType: 'user', principalId: { [Op.notIn]: participants },
      },
      transaction: tx,
    });
    await grantDeliberateReads(tenantId, documentIds, participants, letter.createdBy, tx);
  } else if (letter.departmentId) {
    const members = await UserDepartment.findAll({ where: { departmentId: letter.departmentId }, attributes: ['userId'], transaction: tx });
    const rows = documentIds.flatMap((resourceId) =>
      members.map((m) => ({
        tenantId, resourceType: 'document' as const, resourceId,
        principalType: 'user' as const, principalId: m.userId,
        effect: 'ALLOW' as const, permission: 'document:read', grantedById: letter.createdBy,
        origin: 'DEPT_SNAPSHOT',
      })),
    );
    if (rows.length > 0) await AclEntry.bulkCreate(rows, { transaction: tx, ignoreDuplicates: true });
  }
  await invalidateAfter(tx, tenantId, documentIds);
}
