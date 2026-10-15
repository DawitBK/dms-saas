// S5-07: Daily HMAC audit chain verification worker
// Runs at 04:00 daily to verify the entire audit chain integrity
import { Worker, Job, Queue } from "bullmq";
import { logger } from "../../../core/logger.js";
import { getRedis } from "../../cache/redis.js";
import { verifyAuditChain } from "../../../modules/audit/audit.service.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

const AUDIT_CHAIN_QUEUE = "audit-chain-verification";

export function startAuditChainWorker() {
  const redis = getRedis();
  if (!redis) {
    logger.warn("Redis not configured; audit chain worker will not start");
    return null;
  }

  const queue = new Queue(AUDIT_CHAIN_QUEUE, { connection: redis });
  attachErrorLogger(queue, AUDIT_CHAIN_QUEUE);

  // S5-07: Schedule daily audit chain verification at 04:00
  queue.add(
    "verify-chain",
    { type: "verify-chain" },
    {
      repeat: {
        pattern: "0 4 * * *" // Daily at 04:00
      },
      jobId: "daily-audit-chain-verify"
    }
  ).catch((error) => {
    logger.error({ error }, "Failed to schedule daily audit chain verification job");
  });

  const worker = new Worker(
    AUDIT_CHAIN_QUEUE,
    async (job: Job) => {
      const { type } = job.data;

      if (type === "verify-chain") {
        logger.info("Running daily audit chain integrity verification");
        const result = await verifyAuditChain();

        if (!result.valid) {
          logger.error(
            { brokenAt: result.brokenAt?.toString(), message: result.message },
            "CRITICAL: Audit chain integrity violation detected!"
          );
        } else {
          logger.info({ message: result.message }, "Audit chain integrity verification passed");
        }

        return result;
      }

      throw new Error(`Unknown audit chain worker job type: ${type}`);
    },
    {
      connection: redis,
      concurrency: 1
    }
  );

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Audit chain verification job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, "Audit chain verification job failed");
    reportJobFailure(AUDIT_CHAIN_QUEUE, error, job?.id);
  });
  attachErrorLogger(worker, AUDIT_CHAIN_QUEUE);

  logger.info("Audit chain verification worker started with daily schedule (04:00)");
  return worker;
}

export const AUDIT_CHAIN_QUEUE_NAME = AUDIT_CHAIN_QUEUE;
