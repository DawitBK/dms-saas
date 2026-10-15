import { Queue } from "bullmq";
import { getRedis } from "../cache/redis.js";
import { logger } from "../../core/logger.js";
import { recordSystemError } from "../alerting/adminAlerts.js";

export const queueNames = [
  "EMAILS",
  "WEBSOCKET_EVENTS",
  "OCR_PROCESSING",
  "WORKFLOW_SLA",
  "RETENTION_ENGINE",
  "LEGAL_HOLD_APPLY",
  "SEARCH_INDEX",
  "ARCHIVE",
  "SIGNING_EVENTS",
  "DEAD_LETTER",
  "VIRUS_SCAN" // S4-09
] as const;

export type QueueName = (typeof queueNames)[number];

// Every BullMQ Worker/Queue/QueueEvents instance MUST have an 'error'
// listener or Node crashes the ENTIRE process on any internal BullMQ/Redis
// error (a transient reconnect, a lock-renewal hiccup, etc.) — standard
// EventEmitter behavior (an 'error' event with zero listeners throws), and
// BullMQ's own docs call this out explicitly. Confirmed live as the actual
// cause of repeated silent backend crashes during OCR processing: the "OCR
// worker" Worker instance had no 'error' listener at all, so a transient
// Redis hiccup mid-job took down every user's session, not just that one
// job. Every Worker/Queue construction site in infrastructure/queue must
// call this — it's not defensive boilerplate, it's the actual fix.
export function attachErrorLogger(
  emitter: { on(event: "error", cb: (err: Error) => void): unknown },
  label: string,
): void {
  emitter.on("error", (err: Error) => {
    logger.error({ err, queue: label }, `${label} error`);
    // Infra-level BullMQ/Redis fault (a reconnect, a lock-renewal hiccup),
    // distinct from a single job's business-logic failure — see
    // reportJobFailure below for that. Both route through the same
    // Slack/email admin alerts and /operations/system-errors panel as every
    // other layer of this platform.
    recordSystemError({
      method: "QUEUE",
      route: label,
      errorName: err.name,
      errorMessage: err.message,
      requestId: "n/a",
    });
  });
}

/**
 * Call this alongside (not instead of) each worker's own `logger.error(...)`
 * in its `worker.on("failed", ...)` handler. Every BullMQ worker in this
 * codebase already logs a failed job locally; this is the one line that
 * additionally makes it alert like everything else — a retention sweep, an
 * OCR job, an outbound email, an audit-chain verification, etc. failing
 * silently in the background was exactly the kind of fault that never
 * reached an admin before this module existed.
 */
export function reportJobFailure(label: string, err: unknown, jobId?: string | number): void {
  recordSystemError({
    method: "WORKER",
    route: label,
    errorName: err instanceof Error ? err.name : "JobFailed",
    errorMessage: err instanceof Error ? err.message : String(err),
    requestId: jobId !== undefined ? String(jobId) : "n/a",
  });
}

export function createQueue(name: QueueName) {
  const connection = getRedis();
  if (!connection) return null;
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 100 },
    },
  });
  attachErrorLogger(queue, name);
  return queue;
}
