// Automatic escalation of overdue approval steps (audit finding #23 "SLA reminders -> escalation that acts").
//
// The SLA worker (infrastructure/queue/workers/ApprovalSlaWorker.ts) already flags a PENDING step once `due_at` has
// passed (`sla_breached_at`) and notifies the assignee, the role holders and the submitter. That told people; it never
// changed who could act, so a step assigned to someone on leave stayed stuck until an approval admin noticed.
//
// Escalation acts. APPROVAL_ESCALATION.graceHours after the breach flag, the step is escalated ONCE:
//   * escalation targets are the DEPARTMENT HEAD(S) of the item's department (members holding approval:decide and
//     department:manage), walking up to the nearest parent department that has one; if there is none, the tenant's
//     APPROVAL ADMINS (approval:decide + approval:admin) who are in the item's department or read across departments;
//   * they are ADDED as co-deciders (`approval_steps.escalated_to_user_ids`); the assignee keeps the step, nobody is
//     removed, and the step stays PENDING -- the same decide path, guards and audit apply to an escalatee;
//   * never the current assignee, the item's author or submitter (self-approval stays impossible) and never the hidden
//     platform administrator; at most APPROVAL_ESCALATION.maxTargets people;
//   * the targets are granted read access to the item (attachments included), notified, and the event is audited
//     (APPROVAL_STEP_ESCALATED). If nobody qualifies the step is still marked escalated (audited with no targets) so the
//     sweep does not retry forever; the breach notification has already gone to the submitter.
//
// Everything is switched and tuned in ONE place: config/env.ts (APPROVAL_ESCALATION_ENABLED, _GRACE_HOURS, _MAX_TARGETS).

import { Op, QueryTypes } from "sequelize";
import {
  ApprovalChain,
  ApprovalStep,
  Department,
  Document,
  FormInstance,
  FormTemplate,
  User,
  sequelize,
} from "../../infrastructure/database/index.js";
import { config } from "../../config/env.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { logger } from "../../core/logger.js";
import { AUDIT_EVENTS } from "../audit/auditEvents.js";
import { writeAuditLog } from "../audit/audit.service.js";
import { fanOut } from "../notifications/notifications.service.js";
import { runInTransaction } from "../../shared/transaction.js";
import { notPlatformAdminSql } from "../../shared/platformAdmin.js";
import { getResolvedRolePermissions } from "../roles/roles.service.js";
import { normalizeApprovalDepartmentId } from "./stepRules.js";
import { grantChainParticipantAcl } from "./approvals.service.js";

/** The escalation policy. Read from config on every use (so a changed env value and tests both take effect). */
export const APPROVAL_ESCALATION = {
  get enabled(): boolean { return config.APPROVAL_ESCALATION_ENABLED; },
  get graceHours(): number { return config.APPROVAL_ESCALATION_GRACE_HOURS; },
  get maxTargets(): number { return config.APPROVAL_ESCALATION_MAX_TARGETS; },
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_PARENT_WALK = 10;

/** Names of the roles (in this tenant) that grant every one of the permissions. */
async function rolesGranting(tenantId: string, permissions: string[]): Promise<string[]> {
  const rows = await sequelize.query<{ name: string }>("SELECT name FROM roles", { type: QueryTypes.SELECT });
  const out: string[] = [];
  for (const r of rows ?? []) {
    const perms = (await getResolvedRolePermissions(r.name, tenantId)) as readonly string[];
    if (permissions.every((p) => perms.includes(p))) out.push(r.name);
  }
  return out;
}

type Candidate = { id: string };

async function activeHolders(
  tenantId: string,
  roleNames: string[],
  exclude: string[],
  max: number,
  departmentId: string | null,
): Promise<Candidate[]> {
  if (roleNames.length === 0) return [];
  const rows = await sequelize.query<{ id: string }>(
    `SELECT DISTINCT u.id, u.last_name, u.first_name
       FROM users u
       INNER JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = :tenantId
       INNER JOIN user_roles ur ON ur.user_id = u.id
       INNER JOIN roles r ON r.id = ur.role_id AND r.name IN (:roleNames)
       ${departmentId ? "INNER JOIN user_departments ud ON ud.user_id = u.id AND ud.department_id = :departmentId" : ""}
      WHERE u.is_active = true AND u.deleted_at IS NULL
        AND u.id NOT IN (:exclude)
        AND ${notPlatformAdminSql("u.id")}
      ORDER BY u.last_name, u.first_name, u.id
      LIMIT :max`,
    { replacements: { tenantId, roleNames, departmentId, exclude: [NIL_UUID, ...exclude], max }, type: QueryTypes.SELECT },
  );
  return rows ?? [];
}

/**
 * Who an overdue step escalates to. See the file header for the order and the exclusions.
 * `departmentId` is the item's normalised department (null = no single department).
 */
export async function resolveEscalationTargets(args: {
  tenantId: string;
  departmentId: string | null;
  exclude: string[];
  max?: number;
}): Promise<string[]> {
  const max = args.max ?? APPROVAL_ESCALATION.maxTargets;

  // 1. Heads of the item's department, then of the nearest ancestor that has one.
  const headRoles = await rolesGranting(args.tenantId, [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.DEPT_MANAGE]);
  let deptId: string | null = args.departmentId;
  for (let depth = 0; deptId && depth < MAX_PARENT_WALK; depth++) {
    const heads = await activeHolders(args.tenantId, headRoles, args.exclude, max, deptId);
    if (heads.length > 0) return heads.map((h) => h.id);
    const dept: Department | null = await Department.findOne({ where: { id: deptId, tenantId: args.tenantId }, attributes: ["id", "parentId"] });
    deptId = dept?.parentId ?? null;
  }

  // 2. Approval admins: in the item's department, or reading across departments (so they can really decide it).
  const adminRoles = await rolesGranting(args.tenantId, [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN]);
  if (!args.departmentId) return (await activeHolders(args.tenantId, adminRoles, args.exclude, max, null)).map((h) => h.id);
  const readAllRoles = await rolesGranting(args.tenantId, [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.APPROVAL_ADMIN, PERMISSIONS.DOCUMENT_READ_ALL]);
  const inDept = await activeHolders(args.tenantId, adminRoles, args.exclude, max, args.departmentId);
  const acrossDepartments = await activeHolders(args.tenantId, readAllRoles, [...args.exclude, ...inDept.map((c) => c.id)], max, null);
  return [...inDept, ...acrossDepartments].slice(0, max).map((c) => c.id);
}

type SystemItem = {
  title: string;
  departmentId: string | null;
  documentId: string | null;
  ownerId: string | null;
};

/** The item behind a chain, loaded without a request user (the sweep has none). Null if it is gone or trashed. */
async function loadSystemItem(chain: ApprovalChain, tenantId: string): Promise<SystemItem | null> {
  if (chain.itemType === "FORM_TEMPLATE") {
    const tpl = await FormTemplate.findOne({ where: { id: chain.itemId, tenantId } });
    return tpl ? { title: tpl.name, departmentId: tpl.departmentId ?? null, documentId: null, ownerId: tpl.createdBy } : null;
  }
  let documentId: string | null = chain.itemId;
  if (chain.itemType === "FORM_INSTANCE") {
    const instance = await FormInstance.findByPk(chain.itemId);
    documentId = instance?.documentId ?? null;
  }
  const doc = documentId ? await Document.findByPk(documentId) : null;
  if (!doc || doc.tenantId !== tenantId || doc.deletedAt) return null;
  return {
    title: doc.title,
    departmentId: await normalizeApprovalDepartmentId(tenantId, doc.departmentId ?? null),
    documentId: doc.id,
    ownerId: doc.ownerId ?? null,
  };
}

export type EscalationResult = { escalated: boolean; targets: string[] };

/** Escalate one overdue step. Idempotent: the claim is a status- and `escalated_at`-guarded update. */
export async function escalateStep(stepId: string, tenantId: string, now: Date = new Date()): Promise<EscalationResult> {
  const none: EscalationResult = { escalated: false, targets: [] };
  if (!APPROVAL_ESCALATION.enabled) return none;

  const step = await ApprovalStep.findOne({ where: { id: stepId, tenantId, status: "PENDING", escalatedAt: { [Op.is]: null } } });
  if (!step) return none;
  const chain = await ApprovalChain.findOne({ where: { id: step.chainId, tenantId, status: "IN_REVIEW" } });
  if (!chain) return none;
  const item = await loadSystemItem(chain, tenantId);
  if (!item) return none;

  const exclude = [chain.submittedBy, ...(item.ownerId ? [item.ownerId] : []), ...(step.assignedUserId ? [step.assignedUserId] : [])];
  const targets = await resolveEscalationTargets({ tenantId, departmentId: item.departmentId, exclude });

  const claimed = await runInTransaction(async (tx) => {
    // Guarded claim: of two sweeps (or a sweep racing a decision) exactly one escalates.
    const [updated] = await ApprovalStep.update(
      { escalatedAt: now, escalatedToUserIds: targets },
      { where: { id: stepId, status: "PENDING", escalatedAt: { [Op.is]: null } }, transaction: tx },
    );
    if (updated !== 1) return false;
    if (targets.length > 0) {
      // Recorded as granted on behalf of the submitter: the sweep is a system actor and the column needs a real user.
      await grantChainParticipantAcl(item.documentId, tenantId, chain.submittedBy, targets.map((id) => ({ assignedUserId: id })), tx);
    }
    return true;
  });
  if (!claimed) return none;

  await writeAuditLog({
    eventType: AUDIT_EVENTS.APPROVAL_STEP_ESCALATED,
    tenantId,
    documentId: item.documentId ?? undefined,
    actionDetails: {
      chainId: chain.id,
      stepId,
      itemType: chain.itemType,
      itemId: chain.itemId,
      documentId: item.documentId,
      assignedUserId: step.assignedUserId,
      assignedRole: step.assignedRole,
      escalatedTo: targets,
      breachedAt: step.slaBreachedAt,
      graceHours: APPROVAL_ESCALATION.graceHours,
    },
  });

  if (targets.length === 0) {
    logger.warn({ stepId, chainId: chain.id }, "overdue approval step escalated but no eligible department head or approval admin exists");
    return { escalated: true, targets };
  }

  const people = await User.findAll({ where: { id: { [Op.in]: targets } }, attributes: ["id", "firstName", "lastName"], raw: true });
  const names = (people as unknown as Array<{ firstName: string; lastName: string }>).map((p) => (p.firstName + " " + p.lastName).trim());
  await fanOut({
    type: "APPROVAL_STEP_ESCALATED",
    tenantId,
    recipientIds: [...new Set([...targets, chain.submittedBy, ...(step.assignedUserId ? [step.assignedUserId] : [])])],
    severity: "WARNING",
    payload: {
      chainId: chain.id,
      stepId,
      stepType: step.stepType,
      itemType: chain.itemType,
      itemId: chain.itemId,
      documentId: item.documentId ?? undefined,
      title: item.title,
      escalatedToNames: names.join(", "),
    },
  }).catch((err) => logger.warn({ err, stepId }, "escalation notification failed"));
  return { escalated: true, targets };
}

/** One tenant's escalation sweep: breached, still pending, un-escalated steps older than the grace period. Returns how many escalated. */
export async function escalateOverdueSteps(tenantId: string, now: Date = new Date()): Promise<number> {
  if (!APPROVAL_ESCALATION.enabled) return 0;
  const cutoff = new Date(now.getTime() - APPROVAL_ESCALATION.graceHours * 3_600_000);
  const due = await ApprovalStep.findAll({
    where: {
      tenantId,
      status: "PENDING",
      slaBreachedAt: { [Op.lte]: cutoff },
      escalatedAt: { [Op.is]: null },
    },
    attributes: ["id"],
    limit: 200,
  });
  let escalated = 0;
  for (const s of due) {
    try {
      if ((await escalateStep(s.id, tenantId, now)).escalated) escalated++;
    } catch (err) {
      logger.error({ err, stepId: s.id, tenantId }, "escalating an overdue approval step failed");
    }
  }
  return escalated;
}
