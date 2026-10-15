import { Worker, Job, Queue } from "bullmq";
import { Op } from "sequelize";
import { getRedis } from "../../cache/redis.js";
import { OutboxEvent, Tenant, WorkflowTask } from "../../database/index.js";
import { logger } from "../../../core/logger.js";
import { withWorkerTenantContext } from "../../../shared/workerTenantContext.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

const WORKFLOW_SLA_QUEUE = "WORKFLOW_SLA";

async function checkWorkflowSlas() {
  logger.info("checking workflow slas");
  const now = new Date();
  let breached = 0;
  // TEN-1: the initial SELECT used to run with no app.current_tenant GUC set
  // at all — under a hardened, non-superuser DB role, workflow_tasks' RLS
  // policy makes that predicate NULL->false for every row, so this returned
  // zero rows platform-wide and SLA escalation silently stopped; under a
  // superuser/BYPASSRLS role (dev/test) it instead returned every tenant's
  // pending tasks unfiltered into one array. Same bug shape as, and fixed the
  // same way as, ApprovalSlaWorker's S19 audit fix: loop per tenant so the
  // SELECT itself runs inside that tenant's GUC. The tenants registry itself
  // carries no RLS, so enumerating it needs no context.
  const tenants = await Tenant.findAll({ attributes: ["id"], raw: true });
  for (const t of tenants) {
    // Per-tenant try/catch (same reasoning as ApprovalSlaWorker): one
    // tenant's transient failure must not starve every tenant after it in
    // this tick of SLA escalation.
    try {
      breached += await withWorkerTenantContext(t.id, async () => {
        const pendingTasks = await WorkflowTask.findAll({
          where: { tenantId: t.id, status: "PENDING", slaBreachedAt: { [Op.is]: null } }
        });
        let localBreached = 0;
        for (const task of pendingTasks) {
          if (task.slaDeadlineAt && now > task.slaDeadlineAt) {
            logger.warn({ taskId: task.id }, "workflow task sla breached");
            // Keep the task PENDING (still decidable) but flag the breach —
            // an ESCALATED status would make processTaskDecision reject it
            // forever. Already inside this tenant's ambient transaction, so
            // the flag + outbox row commit atomically together.
            await task.update({ isSlaBreach: true, slaBreachedAt: now });
            await OutboxEvent.create({
              type: "WORKFLOW.SLA_BREACH",
              channel: "EMAIL",
              payload: JSON.stringify({
                taskId: task.id,
                stageName: task.stageName,
                tenantId: task.tenantId,
              })
            });
            localBreached++;
          }
        }
        return localBreached;
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, "workflow SLA check failed for tenant");
    }
  }
  return { breached };
}

export async function createWorkflowWorker() {
  const connection = getRedis();
  if (!connection) {
    logger.warn("Redis not configured; workflow SLA worker will not start");
    return undefined;
  }

  // Schedule the repeatable SLA sweep — without a producer the worker never runs.
  const queue = new Queue(WORKFLOW_SLA_QUEUE, { connection });
  attachErrorLogger(queue, WORKFLOW_SLA_QUEUE);
  await queue
    .add(
      "sla-check",
      { type: "sla-check" },
      { repeat: { pattern: "*/15 * * * *" }, jobId: "workflow-sla-check" }
    )
    .catch((e) => logger.error({ e }, "Failed to schedule workflow SLA check"));

  const worker = new Worker(
    WORKFLOW_SLA_QUEUE,
    async (_job: Job) => checkWorkflowSlas(),
    { connection }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Workflow SLA job failed");
    reportJobFailure(WORKFLOW_SLA_QUEUE, err, job?.id);
  });
  attachErrorLogger(worker, WORKFLOW_SLA_QUEUE);

  logger.info("Workflow SLA worker started (every 15 min)");
  return worker;
}

export const WORKFLOW_SLA_QUEUE_NAME = WORKFLOW_SLA_QUEUE;
