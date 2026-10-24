import { Worker } from 'bullmq';
import { logger } from '../../../core/logger.js';
import { getRedis } from '../../cache/redis.js';
import { createOCRWorker } from './OCRWorker.js';
import { createSearchWorker } from './SearchWorker.js';
import { createWorkflowWorker } from './WorkflowWorker.js';
import { createApprovalSlaWorker } from './ApprovalSlaWorker.js';
import { createRetentionWorker } from './RetentionWorker.js';
import { createEsigningExpiryWorker } from './EsigningExpiryWorker.js';
import { startLockWorker } from './LockWorker.js';
import { startTusUploadCleanupWorker } from './TusUploadCleanupWorker.js';
import { createScanWorker } from './ScanWorker.js';
import { startAuditChainWorker } from './AuditChainWorker.js';
import { createAIWorker } from './AIWorker.js';
import { createEmailWorker } from './EmailWorker.js';
import {
  startRetentionColdWorker,
  startPurgeCoolingWorker,
  startDisposalNotificationWorker,
} from './RetentionPurgeWorker.js';

// DATA-3: `getRedis()` returns null only when REDIS_URL is unset — a config
// gap, not a transient outage (a live Redis crash after boot is already
// handled: BullMQ retries indefinitely in the background, see below). Before
// this fix, that condition produced exactly one `logger.warn` at boot and
// then nothing — no retry (there is nothing to retry without a URL), no
// ongoing signal. Since every worker created here includes retention purge
// and legal-hold-respecting disposal (RetentionPurgeWorker), a missing
// REDIS_URL on a real deploy meant those compliance-critical jobs stopped
// running, indefinitely, with nothing beyond a log line anyone would ever
// see.
//
// The signal has to be cross-process: the production start script runs the API and
// the worker as two SEPARATE OS processes on purpose (so a native worker
// crash can't take the API down with it — its own 2026-08-28 comment), and
// `/operations/health` is served BY the API process. An in-process flag here
// would be invisible there. Postgres (WorkerHeartbeat, required
// infrastructure regardless of Redis state) is the channel instead: touched
// at boot and re-touched on an interval, so `operations.routes.ts` can
// report both "never started" and "started, then went silent" — not just the
// boot-time case.
const HEARTBEAT_ID = "worker";
const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

async function touchWorkerHeartbeat(status: "ok" | "error", reason?: string): Promise<void> {
  try {
    // Defensive: main.ts (unused by any real deployment today — both
    // .env/.env.production set ENABLE_QUEUE_WORKERS=false, matching
    // the production start script's two-process split) calls startWorkers() BEFORE
    // initModels()/connectDB(), the same ordering hazard OCRWorker.ts already
    // documents. bin/worker.ts (the real entrypoint) calls them first, so
    // this succeeds there; failing here must never block worker startup.
    const { WorkerHeartbeat } = await import("../../database/index.js");
    await WorkerHeartbeat.upsert({ id: HEARTBEAT_ID, status, reason: reason ?? null, updatedAt: new Date() });
  } catch (err) {
    logger.warn({ err }, "failed to write worker heartbeat (non-fatal)");
  }
}

/** Read by operations.routes.ts's /operations/health — cross-process, unlike an in-memory flag. */
export async function getWorkerHealthStatus(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { WorkerHeartbeat } = await import("../../database/index.js");
    const row = await WorkerHeartbeat.findByPk(HEARTBEAT_ID);
    if (!row) return { ok: false, reason: "no worker heartbeat has ever been recorded" };
    const ageMs = Date.now() - row.updatedAt.getTime();
    if (ageMs > HEARTBEAT_STALE_AFTER_MS) {
      return { ok: false, reason: `worker heartbeat is stale (last seen ${Math.round(ageMs / 1000)}s ago) — the worker process may have crashed` };
    }
    if (row.status !== "ok") return { ok: false, reason: row.reason ?? "worker reported an error at boot" };
    return { ok: true };
  } catch (err) {
    logger.warn({ err }, "failed to read worker heartbeat");
    return { ok: false, reason: "worker heartbeat unreadable" };
  }
}

export async function startWorkers(): Promise<Worker[]> {
  const redis = getRedis();
  if (!redis) {
    const reason =
      "REDIS_URL is not configured — every background worker is offline, including retention purge, legal-hold-respecting disposal, and approval/workflow SLA escalation. This will not self-heal: it requires setting REDIS_URL and restarting the process.";
    logger.error({ marker: "WORKERS_OFFLINE_NO_REDIS" }, reason);
    await touchWorkerHeartbeat("error", reason);
    // Best-effort — mirrors outbox.ts's own DEAD_LETTER fix ("a log line is
    // not an alert"). Dynamic import avoids a module cycle the same way
    // outbox.ts's own notifications.service import does.
    void (async () => {
      try {
        const { fanOut } = await import("../../../modules/notifications/notifications.service.js");
        await fanOut({
          type: "WORKERS_OFFLINE",
          tenantId: "system",
          severity: "CRITICAL",
          payload: { reason },
        });
      } catch (err) {
        logger.error({ err }, "failed to send WORKERS_OFFLINE platform alert");
      }
    })();
    return [];
  }
  // The shared client is lazyConnect and reports 'wait' until first use; if an
  // import already issued a command it is connecting/ready and connect() throws
  // "Redis is already connecting/connected" — only connect from the idle state.
  // A real connect failure is non-fatal either way: BullMQ clients retry forever
  // in the background. But this client has no retryStrategy cutoff, so its own
  // connect() promise never rejects on a down Redis — it just stays pending,
  // which silently blocked worker/server bootstrap entirely (app.listen() never
  // ran) instead of the intended "keep retrying in the background" degrade. Race
  // it against a timeout so a down Redis can only ever delay boot, never hang it.
  if (redis.status === 'wait') {
    await Promise.race([
      redis.connect().catch((error: unknown) => {
        logger.warn({ error }, 'redis connect failed at worker bootstrap; workers will keep retrying');
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  const workers: (Worker | null | undefined)[] = await Promise.all([
    createOCRWorker(),
    createSearchWorker(),
    createWorkflowWorker(),
    createApprovalSlaWorker(),
    createRetentionWorker(),
    createAIWorker(),
    createEsigningExpiryWorker(),
    createEmailWorker(),
  ]);

  workers.push(
    startLockWorker(),
    startTusUploadCleanupWorker(),
    createScanWorker(),
    startAuditChainWorker(),
    startRetentionColdWorker(),
    startPurgeCoolingWorker(),
    startDisposalNotificationWorker(),
  );

  logger.info('workers bootstrap complete');
  await touchWorkerHeartbeat("ok");
  // Re-touch periodically so a LATER silent crash of the whole worker
  // process (not just a failure to start) also ages the heartbeat past
  // HEARTBEAT_STALE_AFTER_MS and shows up in /operations/health — closing
  // the "no ongoing health signal" half of DATA-3, not just "no retry".
  // unref() so this interval alone never keeps the process alive past a
  // graceful shutdown.
  setInterval(() => void touchWorkerHeartbeat("ok"), HEARTBEAT_INTERVAL_MS).unref();

  return workers.filter((w): w is Worker => w != null);
}
