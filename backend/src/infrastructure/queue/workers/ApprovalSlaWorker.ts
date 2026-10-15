import { Worker, Job, Queue } from "bullmq";
import { Op } from "sequelize";
import { getRedis } from "../../cache/redis.js";
import { ApprovalStep, ApprovalChain, Department, Document, FormInstance, OutboxEvent, Tenant } from "../../database/index.js";
import { logger } from "../../../core/logger.js";
import { withWorkerTenantContext } from "../../../shared/workerTenantContext.js";
import { fanOut } from "../../../modules/notifications/notifications.service.js";
import { resolveRoleHolders } from "../../../modules/approvals/approvals.service.js";
import { escalateOverdueSteps } from "../../../modules/approvals/escalation.service.js";
import { escalateOverdueLetterSteps, flagOverdueLetterSteps } from "../../../modules/letters/letterEscalation.service.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

const APPROVAL_SLA_QUEUE = "APPROVAL_SLA";

/**
 * H6: sweep overdue engine approval steps. The unified engine computed and
 * stored `due_at` from `sla_hours`, and the UI even rendered overdue steps in
 * red — but no worker ever detected a breach (the only SLA sweeper still
 * queried the legacy workflow_tasks table). A step assigned to an unavailable
 * approver would blow its SLA and sit forever with zero escalation.
 *
 * For each newly-overdue PENDING step we flag `sla_breached_at` (so it fires
 * once), notify the assignee / current role holders AND the submitter (so the
 * breach surfaces in My Work and the submitter can nudge/reassign), and enqueue
 * an escalation email.
 */
async function sweepApprovalSlas() {
  const now = new Date();
  // Iterate per tenant so the initial overdue-step SELECT runs INSIDE that
  // tenant's `app.current_tenant` GUC (S19 audit finding, High-latent). A single
  // un-scoped ApprovalStep.findAll returns ZERO rows the moment the app runs as
  // the intended non-superuser DB role: the approval_steps RLS policy is
  // `USING (tenant_id = nullif(current_setting('app.current_tenant',true),''))`
  // with no null-tenant escape valve, so with the GUC unset the predicate is
  // NULL→false for every row and all SLA escalation silently stops. The tenants
  // registry itself is not RLS-protected, so enumerating it needs no context.
  const tenants = await Tenant.findAll({ attributes: ["id"], raw: true });
  let breached = 0;
  let escalated = 0;
  for (const t of tenants) {
    // Per-tenant try/catch (S19 re-audit 3.1): withWorkerTenantContext rethrows
    // on error, so without this a single tenant's transient failure would abort
    // the loop and starve every tenant iterated after it of SLA escalation for
    // this tick. Isolate each tenant; a persistent failure only affects its own.
    try {
      breached += await withWorkerTenantContext(t.id, async () => {
      const overdue = await ApprovalStep.findAll({
        where: {
          tenantId: t.id,
          status: "PENDING",
          slaBreachedAt: { [Op.is]: null },
          dueAt: { [Op.lt]: now }, // NULL due_at is never < now, so unscheduled steps are excluded
        },
        limit: 500,
      });
      if (overdue.length === 0) return 0;

      // Batch-load the parent chains and (for DOCUMENT items) titles in two
      // queries instead of two per step — the sweep was ~5-6 round-trips × up to
      // 500 steps (S19 audit N+1 finding).
      const chainIds = [...new Set(overdue.map((s) => s.chainId))];
      const chains = await ApprovalChain.findAll({ where: { id: { [Op.in]: chainIds } } });
      const chainById = new Map(chains.map((c) => [c.id, c]));
      const docItemIds = [
        ...new Set(chains.filter((c) => c.itemType === "DOCUMENT").map((c) => c.itemId)),
      ];
      // FORM_INSTANCE chains have no departmentId of their own — same as
      // approvals.service.ts's loadItem, it comes from the instance's backing
      // Document.
      const formInstanceItemIds = [
        ...new Set(chains.filter((c) => c.itemType === "FORM_INSTANCE").map((c) => c.itemId)),
      ];
      const docDeptByFormInstanceId = new Map<string, string>();
      if (formInstanceItemIds.length > 0) {
        const instances = await FormInstance.findAll({
          where: { id: { [Op.in]: formInstanceItemIds } },
          attributes: ["id", "documentId"],
        });
        for (const inst of instances) if (inst.documentId) docDeptByFormInstanceId.set(inst.id, inst.documentId);
      }
      const allDocIds = [...new Set([...docItemIds, ...docDeptByFormInstanceId.values()].filter((id): id is string => Boolean(id)))];
      const docTitleById = new Map<string, string>();
      const docDeptById = new Map<string, string | null>();
      if (allDocIds.length > 0) {
        const docs = await Document.findAll({
          where: { id: { [Op.in]: allDocIds } },
          attributes: ["id", "title", "departmentId"],
        });
        for (const d of docs) {
          if (d.title) docTitleById.set(d.id, d.title);
          docDeptById.set(d.id, d.departmentId ?? null);
        }
      }
      // itemId (DOCUMENT's own id, or a FORM_INSTANCE's id resolved through
      // its backing document) -> that document's raw departmentId.
      const rawDeptByItemId = new Map<string, string | null>();
      for (const id of docItemIds) rawDeptByItemId.set(id, docDeptById.get(id) ?? null);
      for (const [instId, docId] of docDeptByFormInstanceId) rawDeptByItemId.set(instId, docDeptById.get(docId) ?? null);

      // Batch the department-scoped role-holder resolution the loop below
      // needs — the exact same N+1 shape the "S19 audit N+1 finding" comment
      // above already fixed once for the chain/document lookups; the later
      // department-scoping fix (notifyPendingStep parity) re-paid that cost
      // here by awaiting normalizeApprovalDepartmentId() + resolveRoleHolders()
      // once PER STEP. Resolved once per distinct (normalized department,
      // role) combination instead — in practice far fewer than one per step,
      // since many overdue steps share the same department/role pair.
      const normalizedDeptCache = new Map<string, string | null>(); // raw deptId -> normalized
      const roleHoldersByKey = new Map<string, string[]>(); // `${normalizedDeptId ?? ''}::${role}` -> recipient ids
      {
        const roleSteps = overdue.filter((s) => !s.assignedUserId && s.assignedRole);
        const candidateDeptIds = [...new Set(
          roleSteps
            .map((s) => {
              const chain = chainById.get(s.chainId);
              return chain ? rawDeptByItemId.get(chain.itemId) ?? null : null;
            })
            .filter((id): id is string => Boolean(id)),
        )];
        const uncatDeptIds = candidateDeptIds.length
          ? new Set(
              (await Department.findAll({ where: { id: { [Op.in]: candidateDeptIds }, tenantId: t.id, code: "UNCAT" }, attributes: ["id"] })).map(
                (d) => d.id,
              ),
            )
          : new Set<string>();
        for (const id of candidateDeptIds) normalizedDeptCache.set(id, uncatDeptIds.has(id) ? null : id);

        const rolesByNormalizedDept = new Map<string | null, Set<string>>();
        for (const s of roleSteps) {
          const chain = chainById.get(s.chainId);
          const rawDeptId = chain ? rawDeptByItemId.get(chain.itemId) ?? null : null;
          const normalized = rawDeptId ? normalizedDeptCache.get(rawDeptId) ?? null : null;
          const set = rolesByNormalizedDept.get(normalized) ?? new Set<string>();
          set.add(s.assignedRole!);
          rolesByNormalizedDept.set(normalized, set);
        }
        for (const [deptId, roles] of rolesByNormalizedDept) {
          const byRole = await resolveRoleHolders([...roles], t.id, deptId);
          for (const [role, holders] of byRole) roleHoldersByKey.set(`${deptId ?? ""}::${role}`, holders.map((h) => h.id));
        }
      }

      let localBreached = 0;
      for (const step of overdue) {
        const chain = chainById.get(step.chainId);
        if (!chain || chain.status !== "IN_REVIEW") continue; // cancelled/suspended → not overdue
        const title =
          chain.itemType === "DOCUMENT" ? docTitleById.get(chain.itemId) ?? chain.itemType : chain.itemType;

        // Guarded flag: only the first sweep to see it PENDING-and-un-flagged
        // wins. The `status='PENDING'` clause (added per S19 audit) prevents a
        // step decided between the SELECT and this UPDATE from being flagged and
        // spuriously escalated.
        const [flagged] = await ApprovalStep.update(
          { slaBreachedAt: now },
          { where: { id: step.id, status: "PENDING", slaBreachedAt: { [Op.is]: null } } },
        );
        if (flagged === 0) continue;

        let recipientIds: string[] = [];
        if (step.assignedUserId) {
          recipientIds = [step.assignedUserId];
        } else if (step.assignedRole) {
          // Department-scoped the same way resolvePendingStepRecipients /
          // notifyPendingStep are (approvals.service.ts) — this query used to
          // resolve role holders tenant-wide, so an SLA breach on a
          // department-scoped step notified every tenant-wide holder of the
          // role (including the document's title/id), not just the people who
          // could actually act on it. assertStepIsActionable already refuses
          // the decision for anyone outside the department; this just makes
          // who gets notified agree with who can act. Looked up from the
          // batch resolved above, not re-queried per step.
          const rawDeptId = rawDeptByItemId.get(chain.itemId) ?? null;
          const normalizedDeptId = rawDeptId ? normalizedDeptCache.get(rawDeptId) ?? null : null;
          recipientIds = roleHoldersByKey.get(`${normalizedDeptId ?? ""}::${step.assignedRole}`) ?? [];
        }
        // Escalate to the submitter too, so a stuck step is visible to whoever can act.
        const escalationIds = [...new Set([...recipientIds, chain.submittedBy])];

        if (escalationIds.length > 0) {
          await fanOut({
            type: "APPROVAL_SLA_BREACH",
            tenantId: step.tenantId,
            recipientIds: escalationIds,
            severity: "WARNING",
            payload: { itemType: chain.itemType, itemId: chain.itemId, title, stepId: step.id },
          });
        }
        await OutboxEvent.create({
          type: "APPROVAL.SLA_BREACH",
          channel: "EMAIL",
          payload: JSON.stringify({
            itemType: chain.itemType,
            itemId: chain.itemId,
            stepId: step.id,
            title,
            tenantId: step.tenantId,
            assignedUserId: step.assignedUserId,
            assignedRole: step.assignedRole,
          }),
        });
        localBreached++;
      }
      return localBreached;
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, "approval SLA sweep failed for tenant");
    }
    // Escalation (escalation.service.ts, config APPROVAL_ESCALATION_*): steps that stayed overdue past the grace
    // period gain their department head(s) / approval admins as co-deciders. Its own try/catch for the same reason.
    try {
      escalated += await withWorkerTenantContext(t.id, () => escalateOverdueSteps(t.id, now));
    } catch (err) {
      logger.error({ err, tenantId: t.id }, "approval escalation sweep failed for tenant");
    }
    // Letters keep their own chain, so their steps get the same two sweeps (letterEscalation.service.ts): flag the
    // overdue ones, then escalate those that stayed overdue past the grace period. Isolated per tenant like the above.
    try {
      breached += await withWorkerTenantContext(t.id, () => flagOverdueLetterSteps(t.id, now));
      escalated += await withWorkerTenantContext(t.id, () => escalateOverdueLetterSteps(t.id, now));
    } catch (err) {
      logger.error({ err, tenantId: t.id }, "letter SLA sweep failed for tenant");
    }
  }
  if (escalated > 0) logger.warn({ escalated }, "overdue approval steps escalated");
  if (breached > 0) logger.warn({ breached }, "approval-engine SLA breaches detected");
  return { breached, escalated };
}

export async function createApprovalSlaWorker() {
  const connection = getRedis();
  if (!connection) {
    logger.warn("Redis not configured; approval SLA worker will not start");
    return undefined;
  }

  const queue = new Queue(APPROVAL_SLA_QUEUE, { connection });
  attachErrorLogger(queue, APPROVAL_SLA_QUEUE);
  await queue
    .add(
      "sla-check",
      { type: "sla-check" },
      { repeat: { pattern: "*/15 * * * *" }, jobId: "approval-sla-check" },
    )
    .catch((e) => logger.error({ e }, "Failed to schedule approval SLA check"));

  const worker = new Worker(APPROVAL_SLA_QUEUE, async (_job: Job) => sweepApprovalSlas(), { connection });
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Approval SLA job failed");
    reportJobFailure(APPROVAL_SLA_QUEUE, err, job?.id);
  });
  attachErrorLogger(worker, APPROVAL_SLA_QUEUE);

  logger.info("Approval SLA worker started (every 15 min)");
  return worker;
}

export const APPROVAL_SLA_QUEUE_NAME = APPROVAL_SLA_QUEUE;
