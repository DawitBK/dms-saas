// Deadlines and automatic escalation for LETTER review/approval steps.
//
// Until 2026-10-10 a letter step had no clock: a step waiting on someone on leave sat PENDING until a department head
// noticed. The unified approval engine already had both halves (ApprovalSlaWorker flags a breach, escalation.service.ts
// adds the department head as a co-decider); letters keep their own chain, so this is the same policy for them, and
// it deliberately reuses the engine's target resolution and its switches (config APPROVAL_ESCALATION_*) so ONE
// policy governs both.
//
//   1. A step gets `due_at` when it becomes the current step (submit, or the previous step being decided) if the drafter
//      set `slaHours` for it or the tenant set LETTER_STEP_DEFAULT_SLA_HOURS. No hours means no deadline.
//   2. The sweep flags a PENDING step whose `due_at` passed (`sla_breached_at`, once) and tells the assignee, the holders of the
//      assigned role and the drafter.
//   3. APPROVAL_ESCALATION.graceHours after the flag the step escalates ONCE: the department head(s) of the letter's department
//      (else approval admins) are ADDED as co-deciders. The assignee keeps the step, nobody is removed, the step stays
//      PENDING and the normal decide path, guards and audit apply. Never the drafter, never the assignee, never the hidden
//      platform administrator.
//   4. A reassignment or delegation gives the new holder a fresh clock and clears breach and escalation.

import { Op } from 'sequelize';
import { Letter, LetterApprovalStep, User } from '../../infrastructure/database/index.js';
import { logger } from '../../core/logger.js';
import { AUDIT_EVENTS } from '../audit/auditEvents.js';
import { writeAuditLog } from '../audit/audit.service.js';
import { fanOut } from '../notifications/notifications.service.js';
import { runInTransaction } from '../../shared/transaction.js';
import { enqueueWebsocketEvent } from '../../infrastructure/queue/outbox.js';
import { resolveRoleUserIds } from '../../shared/assignmentAdvisory.js';
import { normalizeApprovalDepartmentId } from '../approvals/stepRules.js';
import { APPROVAL_ESCALATION, resolveEscalationTargets } from '../approvals/escalation.service.js';
import { syncLetterDocumentAcl } from './letterDocumentAcl.js';

type StepRow = LetterApprovalStep;

async function openLetterFor(step: StepRow, tenantId: string): Promise<Letter | null> {
  return Letter.findOne({ where: { id: step.letterId, tenantId, status: 'IN_REVIEW' } });
}

async function holdersOf(step: StepRow, letter: Letter): Promise<string[]> {
  if (step.assignedUserId) return [step.assignedUserId];
  if (!step.assignedRole) return [];
  const dept = await normalizeApprovalDepartmentId(letter.tenantId, letter.departmentId ?? null);
  return resolveRoleUserIds(step.assignedRole, letter.tenantId, dept);
}

/** Flag newly overdue PENDING letter steps of one tenant and notify. Returns how many were flagged. */
export async function flagOverdueLetterSteps(tenantId: string, now: Date = new Date()): Promise<number> {
  const letters = await Letter.findAll({ where: { tenantId, status: 'IN_REVIEW' }, attributes: ['id'], raw: true });
  if (letters.length === 0) return 0;
  const overdue = await LetterApprovalStep.findAll({
    where: {
      letterId: { [Op.in]: letters.map((l) => l.id) },
      status: 'PENDING',
      slaBreachedAt: { [Op.is]: null },
      dueAt: { [Op.lt]: now }, // NULL due_at is never < now, so steps without a deadline are excluded
    },
    limit: 500,
  });
  let flagged = 0;
  for (const step of overdue) {
    try {
      // Guarded: only the first sweep to see it pending-and-unflagged wins; a step decided in between is left alone.
      const [claimed] = await LetterApprovalStep.update(
        { slaBreachedAt: now },
        { where: { id: step.id, status: 'PENDING', slaBreachedAt: { [Op.is]: null } } },
      );
      if (claimed !== 1) continue;
      const letter = await openLetterFor(step, tenantId);
      if (!letter) continue;
      const holders = await holdersOf(step, letter);
      await writeAuditLog({
        eventType: AUDIT_EVENTS.LETTER_SLA_BREACHED,
        tenantId,
        actionDetails: { letterId: letter.id, stepId: step.id, dueAt: step.dueAt, assignedUserId: step.assignedUserId, assignedRole: step.assignedRole },
      });
      await fanOut({
        type: 'LETTER_SLA_BREACH',
        tenantId,
        recipientIds: [...new Set([...holders, letter.createdBy])],
        severity: 'WARNING',
        payload: { letterId: letter.id, subject: letter.subject, stepId: step.id, stepType: step.stepType },
      }).catch((err) => logger.warn({ err, stepId: step.id }, 'letter SLA breach notification failed'));
      await enqueueWebsocketEvent('LETTER.SLA_BREACH', {
        tenantId, departmentId: letter.departmentId, letterId: letter.id, subject: letter.subject,
      }).catch(() => {});
      flagged++;
    } catch (err) {
      logger.error({ err, stepId: step.id, tenantId }, 'flagging an overdue letter step failed');
    }
  }
  return flagged;
}

export type LetterEscalationResult = { escalated: boolean; targets: string[] };

/** Escalate one overdue letter step. Idempotent: the claim is a status- and `escalated_at`-guarded update. */
export async function escalateLetterStep(stepId: string, tenantId: string, now: Date = new Date()): Promise<LetterEscalationResult> {
  const none: LetterEscalationResult = { escalated: false, targets: [] };
  if (!APPROVAL_ESCALATION.enabled) return none;
  const step = await LetterApprovalStep.findOne({ where: { id: stepId, status: 'PENDING', escalatedAt: { [Op.is]: null } } });
  if (!step) return none;
  const letter = await openLetterFor(step, tenantId);
  if (!letter) return none;

  const dept = await normalizeApprovalDepartmentId(tenantId, letter.departmentId ?? null);
  const exclude = [letter.createdBy, ...(step.assignedUserId ? [step.assignedUserId] : [])];
  const targets = await resolveEscalationTargets({ tenantId, departmentId: dept, exclude });

  const claimed = await runInTransaction(async (tx) => {
    const [updated] = await LetterApprovalStep.update(
      { escalatedAt: now, escalatedToUserIds: targets },
      { where: { id: stepId, status: 'PENDING', escalatedAt: { [Op.is]: null } }, transaction: tx },
    );
    if (updated !== 1) return false;
    // A participants-only letter's documents must reach the new co-deciders (they are PENDING escalatees now).
    if (targets.length > 0) await syncLetterDocumentAcl(letter.id, tenantId, tx);
    return true;
  });
  if (!claimed) return none;

  await writeAuditLog({
    eventType: AUDIT_EVENTS.LETTER_STEP_ESCALATED,
    tenantId,
    actionDetails: {
      letterId: letter.id, stepId, assignedUserId: step.assignedUserId, assignedRole: step.assignedRole,
      escalatedTo: targets, breachedAt: step.slaBreachedAt, graceHours: APPROVAL_ESCALATION.graceHours,
    },
  });

  if (targets.length === 0) {
    logger.warn({ stepId, letterId: letter.id }, 'overdue letter step escalated but no eligible department head or approval admin exists');
    return { escalated: true, targets };
  }
  const people = await User.findAll({ where: { id: { [Op.in]: targets } }, attributes: ['id', 'firstName', 'lastName'], raw: true });
  const names = (people as unknown as Array<{ firstName: string; lastName: string }>).map((p) => `${p.firstName} ${p.lastName}`.trim());
  await fanOut({
    type: 'LETTER_STEP_ESCALATED',
    tenantId,
    recipientIds: [...new Set([...targets, letter.createdBy, ...(step.assignedUserId ? [step.assignedUserId] : [])])],
    severity: 'WARNING',
    payload: { letterId: letter.id, subject: letter.subject, stepId, stepType: step.stepType, escalatedToNames: names.join(', ') },
  }).catch((err) => logger.warn({ err, stepId }, 'letter escalation notification failed'));
  await enqueueWebsocketEvent('LETTER.STEP_ESCALATED', {
    tenantId, departmentId: letter.departmentId, letterId: letter.id, subject: letter.subject, recipientUserIds: targets,
  }).catch(() => {});
  return { escalated: true, targets };
}

/** One tenant's escalation sweep: breached, still pending, un-escalated letter steps older than the grace period. */
export async function escalateOverdueLetterSteps(tenantId: string, now: Date = new Date()): Promise<number> {
  if (!APPROVAL_ESCALATION.enabled) return 0;
  const cutoff = new Date(now.getTime() - APPROVAL_ESCALATION.graceHours * 3_600_000);
  const letters = await Letter.findAll({ where: { tenantId, status: 'IN_REVIEW' }, attributes: ['id'], raw: true });
  if (letters.length === 0) return 0;
  const due = await LetterApprovalStep.findAll({
    where: {
      letterId: { [Op.in]: letters.map((l) => l.id) },
      status: 'PENDING',
      slaBreachedAt: { [Op.lte]: cutoff },
      escalatedAt: { [Op.is]: null },
    },
    attributes: ['id'],
    limit: 200,
  });
  let escalated = 0;
  for (const s of due) {
    try {
      if ((await escalateLetterStep(s.id, tenantId, now)).escalated) escalated++;
    } catch (err) {
      logger.error({ err, stepId: s.id, tenantId }, 'escalating an overdue letter step failed');
    }
  }
  return escalated;
}
