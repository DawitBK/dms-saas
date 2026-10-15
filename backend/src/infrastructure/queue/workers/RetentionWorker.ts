import { Worker, Job, Queue } from "bullmq";
import { getRedis } from "../../cache/redis.js";
import { logger } from "../../../core/logger.js";
import { processRetentionQueue } from "../../../modules/retention/retention.service.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";

const RETENTION_ENGINE_QUEUE = "RETENTION_ENGINE";

export async function createRetentionWorker() {
  const connection = getRedis();
  if (!connection) {
    logger.warn("Redis not configured; retention engine worker will not start");
    return undefined;
  }

  // Schedule the daily retention sweep (ARCHIVED → DISPOSAL_PENDING). Without a
  // producer the worker never ran and the disposal chain was inert.
  const queue = new Queue(RETENTION_ENGINE_QUEUE, { connection });
  attachErrorLogger(queue, RETENTION_ENGINE_QUEUE);
  await queue
    .add(
      "retention-sweep",
      { type: "retention-sweep" },
      { repeat: { pattern: "0 1 * * *" }, jobId: "retention-engine-daily" }
    )
    .catch((e) => logger.error({ e }, "Failed to schedule retention engine sweep"));

  const worker = new Worker(
    RETENTION_ENGINE_QUEUE,
    async (_job: Job) => {
      logger.info("running daily retention engine job");
      await processRetentionQueue();
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Retention engine job failed");
    reportJobFailure(RETENTION_ENGINE_QUEUE, err, job?.id);
  });
  attachErrorLogger(worker, RETENTION_ENGINE_QUEUE);

  logger.info("Retention engine worker started (daily 01:00)");
  return worker;
}

export const RETENTION_ENGINE_QUEUE_NAME = RETENTION_ENGINE_QUEUE;
