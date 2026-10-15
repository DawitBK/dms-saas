// "My Work" unified inbox (SYSTEM-DECISIONS.md, P1 scope): one aggregate of
// everything waiting on the caller, replacing today's scatter (letter pages /
// Operations → Workflow Queue / signing page / notification bell):
//   * approvals  — pending engine steps (documents + forms) AND pending
//                  letter chain steps assigned to me;
//   * signatures — e-sign requests waiting on me;
//   * audits     — items pending my audit review (D5–D7);
//   * letters    — incoming correspondence assigned to me, with due/overdue.

import { Op } from "sequelize";
import {
  Letter,
  LetterApprovalStep,
  SignatureRecipient,
  SignatureRequest,
  Document,
  User,
  UserDepartment,
} from "../../infrastructure/database/index.js";
import { listMyPendingSteps, MY_WORK_QUEUE_CAP, type CurrentUser } from "./approvals.service.js";
import { listMyPendingAudits } from "./auditStage.service.js";
import { listMySignatureTasks } from "../esigning/esigning.service.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { isLetterOverdue } from "../letters/letters.service.js";

function hasPermission(user: CurrentUser, permission: string): boolean {
  return (user.permissions ?? []).includes(permission);
}

export async function getMyWork(user: CurrentUser) {
  const roles = user.roles ?? [user.role];

  // Same department-scoping rule listMyPendingSteps enforces for engine
  // steps just below (approvals.service.ts) — a role match alone used to be
  // enough to surface a letter step here even for a manager outside the
  // letter's own department, who'd then hit an ACL rejection the moment they
  // tried to act on it. Mirrors letters.service.ts's resolveRoleUserIds /
  // LETTER_READ_ALL bypass, which enforces the same rule at decide-time.
  const canBypassLetterDeptScope = hasPermission(user, PERMISSIONS.LETTER_READ_ALL);
  const myDepartmentIdsPromise = canBypassLetterDeptScope
    ? Promise.resolve(null)
    : UserDepartment.findAll({ where: { userId: user.userId }, attributes: ["departmentId"] }).then(
        (rows) => new Set(rows.map((r) => r.departmentId)),
      );

  const [engineSteps, audits, letterStepsRaw, signatures, assignedLetters, myDepartmentIds] = await Promise.all([
    listMyPendingSteps(user).catch(() => []),
    listMyPendingAudits(user).catch(() => []),
    // Pending letter chain steps assigned to me (letters keep their own engine).
    LetterApprovalStep.findAll({
      where: {
        status: "PENDING",
        [Op.or]: [
          { assignedUserId: user.userId },
          { assignedRole: { [Op.in]: roles } },
          // Overdue steps that escalated to me (letterEscalation.service.ts).
          { escalatedToUserIds: { [Op.contains]: [user.userId] } },
        ],
      },
      include: [
        {
          model: Letter,
          where: { tenantId: user.tenantId, status: "IN_REVIEW" },
          attributes: ["id", "subject", "letterType", "priority", "departmentId", "createdBy", "createdAt"],
        },
      ],
      // Newest-first, matching the engine-steps query in approvals.service.ts
      // — both feed the same "Approvals" list on My Work.
      order: [["createdAt", "DESC"]],
      // Bounded like its engine-side counterpart (MY_WORK_QUEUE_CAP): this
      // matches on `assignedRole IN (my roles)`, so for a widely-held role
      // unbounded meant "every pending letter step in the tenant", fetched
      // once per user per My Work poll.
      limit: MY_WORK_QUEUE_CAP,
    }),
    // E-sign requests waiting on me (internal recipients) — shared with the
    // E-Signing sidebar's "Pending My Signature" queue. My Work is an
    // unpaginated summary inbox, not a paged list, so ask for a high cap
    // rather than the queue page's default page size.
    listMySignatureTasks(user, 0, 100).then((r) => r.data),
    // Incoming correspondence routed to me.
    Letter.findAll({
      where: {
        tenantId: user.tenantId,
        direction: "INCOMING",
        assignedToUserId: user.userId,
        status: { [Op.in]: ["RECEIVED", "RESPONDED"] },
      },
      attributes: ["id", "subject", "referenceNumber", "priority", "dueDate", "receivedDate", "status", "correspondent"],
      include: [{ model: User, as: "creator", attributes: ["id", "firstName", "lastName"] }],
      // Postgres puts NULLs last on ASC by default — undated letters sort last.
      order: [["dueDate", "ASC"], ["createdAt", "ASC"]],
      // Bounded like every other My Work queue (MY_WORK_QUEUE_CAP). Ordered
      // by due date ascending, so the cap drops the least urgent items, which
      // is the right end to lose if a caseworker really is sitting on more
      // than 200 open incoming letters.
      limit: MY_WORK_QUEUE_CAP,
    }),
    myDepartmentIdsPromise,
  ]);

  const letterSteps = letterStepsRaw.filter((s) => {
    if (s.assignedUserId) return true; // named assignment — no department gate
    if ((s.escalatedToUserIds ?? []).includes(user.userId)) return true; // escalation chose me for this letter
    const letter = (s as LetterApprovalStep & { Letter?: Letter }).Letter;
    if (!letter?.departmentId) return true; // no department on the letter — nothing to scope against
    return myDepartmentIds === null || myDepartmentIds.has(letter.departmentId);
  });

  // ENGINE and LETTER steps come from two separate queries (letters keep
  // their own approval-chain implementation, see letters.service.ts) —
  // each is independently newest-first, but concatenating them would just
  // put every ENGINE step ahead of every LETTER step regardless of actual
  // date. Re-sort the merged list so "newest first" holds across both.
  const mergedApprovals = [
    ...engineSteps.map(
      (s) => ({ kind: "ENGINE" as const, ...(s as Record<string, unknown>) }) as { kind: "ENGINE"; createdAt: unknown } & Record<string, unknown>,
    ),
    ...letterSteps.map((s) => {
      const letter = (s as LetterApprovalStep & { Letter?: Letter }).Letter;
      return {
        kind: "LETTER" as const,
        id: s.id,
        letterId: s.letterId,
        stepType: s.stepType,
        stepOrder: s.stepOrder,
        createdAt: s.createdAt,
        title: letter?.subject ?? null,
        priority: letter?.priority ?? null,
        dueAt: s.dueAt ?? null,
        overdue: Boolean(s.dueAt && s.dueAt.getTime() < Date.now()),
        escalatedToMe: !s.assignedUserId && (s.escalatedToUserIds ?? []).includes(user.userId),
      };
    }),
  ].sort((a, b) => new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime());

  return {
    approvals: mergedApprovals,
    signatures: signatures.map((r) => {
      const request = (r as SignatureRecipient & { request?: SignatureRequest & { document?: Document } }).request;
      return {
        recipientId: r.id,
        requestId: r.signatureRequestId,
        status: r.status,
        createdAt: r.createdAt,
        document: request?.document
          ? { id: request.document.id, title: request.document.title, documentName: request.document.documentName }
          : null,
      };
    }),
    audits,
    // FIX (Finding 11): this used to independently re-derive "overdue" as
    // `dueDate < today && status !== 'RESPONDED'` — excluding only RESPONDED,
    // not CLOSED/ARCHIVED, unlike letters.service.ts's isLetterOverdue (the
    // canonical rule). Delegating here means this list and the letters
    // register can never disagree on the same letter again.
    letters: assignedLetters.map((l) => ({
      ...l.get({ plain: true }),
      isOverdue: isLetterOverdue(l.status, l.dueDate),
    })),
  };
}
