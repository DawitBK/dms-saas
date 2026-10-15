import { Worker, Job, Queue } from "bullmq";
import { getRedis } from "../../cache/redis.js";
import { logger } from "../../../core/logger.js";
import { expireSignatureRequests } from "../../../modules/esigning/esigning.service.js";
import { attachErrorLogger, reportJobFailure } from "../queues.js";
// Registers the letters handler for expired ceremonies (this process ends them; see esigning.events.ts).
import "../../../modules/letters/letterSigningRecovery.js";

const ESIGNING_EXPIRY_QUEUE = "ESIGNING_EXPIRY";

export async function createEsigningExpiryWorker() {
  const connection = getRedis();
  if (!connection) {
    logger.warn("Redis not configured; e-signing expiry worker will not start");
    return undefined;
  }

  // Schedule the periodic sweep (sent/partially_signed past expiresAt → expired).
  // signDocument() also enforces expiry lazily on the hot path, but without a
  // producer a request nobody revisits would stay 'sent' forever.
  const queue = new Queue(ESIGNING_EXPIRY_QUEUE, { connection });
  attachErrorLogger(queue, ESIGNING_EXPIRY_QUEUE);
  await queue
    .add(
      "esigning-expiry-sweep",
      { type: "esigning-expiry-sweep" },
      { repeat: { pattern: "0 * * * *" }, jobId: "esigning-expiry-hourly" }
    )
    .catch((e) => logger.error({ e }, "Failed to schedule e-signing expiry sweep"));

  const worker = new Worker(
    ESIGNING_EXPIRY_QUEUE,
    async (_job: Job) => {
      logger.info("running e-signing expiry sweep");
      await expireSignatureRequests();
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "E-signing expiry job failed");
    reportJobFailure(ESIGNING_EXPIRY_QUEUE, err, job?.id);
  });
  attachErrorLogger(worker, ESIGNING_EXPIRY_QUEUE);

  logger.info("E-signing expiry worker started (hourly)");
  return worker;
}

export const ESIGNING_EXPIRY_QUEUE_NAME = ESIGNING_EXPIRY_QUEUE;
