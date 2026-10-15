// S4-13: Lock auto-release worker
// Runs hourly to release expired locks and send expiry warnings

import { Worker, Job, Queue } from "bullmq";
import { logger } from "../../../core/logger.js";
import { getRedis } from "../../cache/redis.js";
import { releaseExpiredLocks, sendLockExpiryWarnings } from "../../../modules/documents/lockService.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

const LOCK_WORKER_QUEUE = "lock-maintenance";

export function startLockWorker() {
  const redis = getRedis();
  if (!redis) {
    logger.warn("Redis not configured; lock worker will not start");
    return null;
  }

  const queue = new Queue(LOCK_WORKER_QUEUE, { connection: redis });
  attachErrorLogger(queue, LOCK_WORKER_QUEUE);

  // S4-13: Schedule hourly lock expiry check
  queue.add(
    "release-expired",
    { type: "release-expired" },
    {
      repeat: {
        pattern: "0 * * * *" // Every hour at minute 0
      },
      jobId: "lock-expiry-release"
    }
  ).catch((error) => {
    logger.error({ error }, "Failed to schedule lock expiry release job");
  });

  // Schedule lock expiry warnings (every 15 minutes to catch 15-min warnings)
  queue.add(
    "send-warnings",
    { type: "send-warnings" },
    {
      repeat: {
        pattern: "*/15 * * * *" // Every 15 minutes
      },
      jobId: "lock-expiry-warnings"
    }
  ).catch((error) => {
    logger.error({ error }, "Failed to schedule lock expiry warnings job");
  });

  const worker = new Worker(
    LOCK_WORKER_QUEUE,
    async (job: Job) => {
      const { type } = job.data;

      if (type === "release-expired") {
        logger.info("Running lock expiry release job");
        const result = await releaseExpiredLocks();
        logger.info({ releasedCount: result.releasedCount }, "Expired locks released");
        return result;
      }

      if (type === "send-warnings") {
        logger.info("Running lock expiry warning job");
        const result = await sendLockExpiryWarnings();
        logger.info({ warningCount: result.warningCount }, "Lock expiry warnings sent");
        return result;
      }

      throw new Error(`Unknown lock worker job type: ${type}`);
    },
    {
      connection: redis,
      concurrency: 1
    }
  );

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Lock worker job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, "Lock worker job failed");
    reportJobFailure(LOCK_WORKER_QUEUE, error, job?.id);
  });
  attachErrorLogger(worker, LOCK_WORKER_QUEUE);

  logger.info("Lock maintenance worker started with hourly schedule");
  return worker;
}

export const LOCK_MAINTENANCE_QUEUE_NAME = LOCK_WORKER_QUEUE;
