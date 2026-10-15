// Sweeps abandoned/incomplete tus resumable uploads from storage/tus-uploads.
// Runs every 6 hours — abandoned uploads have a 24h expiration window (see
// tusUpload.ts), so this cadence catches them well within that window without
// hammering the filesystem.

import { Worker, Job, Queue } from "bullmq";
import { logger } from "../../../core/logger.js";
import { getRedis } from "../../cache/redis.js";
import { cleanupExpiredTusUploads } from "../../../modules/documents/tusUpload.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

const TUS_CLEANUP_QUEUE = "tus-upload-cleanup";

export function startTusUploadCleanupWorker() {
  const redis = getRedis();
  if (!redis) {
    logger.warn("Redis not configured; tus upload cleanup worker will not start");
    return null;
  }

  const queue = new Queue(TUS_CLEANUP_QUEUE, { connection: redis });
  attachErrorLogger(queue, TUS_CLEANUP_QUEUE);

  queue.add(
    "sweep-expired-uploads",
    { type: "sweep-expired-uploads" },
    {
      repeat: {
        pattern: "0 */6 * * *" // Every 6 hours
      },
      jobId: "tus-upload-cleanup-sweep"
    }
  ).catch((error) => {
    logger.error({ error }, "Failed to schedule tus upload cleanup job");
  });

  const worker = new Worker(
    TUS_CLEANUP_QUEUE,
    async (job: Job) => {
      const { type } = job.data;

      if (type === "sweep-expired-uploads") {
        logger.info("Running tus upload cleanup sweep");
        const result = await cleanupExpiredTusUploads();
        logger.info({ removedCount: result.removedCount }, "Tus upload cleanup sweep complete");
        return result;
      }

      throw new Error(`Unknown tus cleanup worker job type: ${type}`);
    },
    {
      connection: redis,
      concurrency: 1
    }
  );

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Tus upload cleanup job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, "Tus upload cleanup job failed");
    reportJobFailure(TUS_CLEANUP_QUEUE, error, job?.id);
  });
  attachErrorLogger(worker, TUS_CLEANUP_QUEUE);

  logger.info("Tus upload cleanup worker started with 6-hourly schedule");
  return worker;
}

export const TUS_CLEANUP_QUEUE_NAME = TUS_CLEANUP_QUEUE;
