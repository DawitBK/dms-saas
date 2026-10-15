// SPRINT-6: schema is managed by SQL migrations. syncDatabase() is removed from startup.
// Run `npm run migrate:up` to set up or update the database schema.
import http from 'node:http';
import { config, assertProductionRuntimeRequirements } from './config/env.js';
import { setupLogger, logger } from './core/logger.js';
import { createApp } from './app.js';
import { connectDB, initModels, sequelize } from './infrastructure/database/index.js';
import { initializeStorage } from './infrastructure/storage/index.js';
import { ensureMeilisearchHealthy } from './infrastructure/search/meilisearch.js';
import { closeSocket, initializeSocket } from './infrastructure/websocket/socket.js';
import { initializeGateway } from './infrastructure/websocket/gateway.js';
import { startWorkers } from './infrastructure/queue/workers/index.js';
import { startOutboxPolling, stopOutboxPolling } from './infrastructure/queue/outbox.js';
import { assertRedisVersion } from './infrastructure/cache/redis.js';
import { reportAntivirusReadiness } from './infrastructure/antivirus/clamscan.js';
import { reportKekReadiness } from './infrastructure/vault/kekSelfTest.js';
import { reportFatalCrash } from './infrastructure/alerting/adminAlerts.js';

/** Never let alerting itself delay a process that is already exiting. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

async function bootstrap() {
  setupLogger();
  assertProductionRuntimeRequirements();
  await assertRedisVersion();

  if (!process.env.TZ) {
    logger.warn('TZ is not set; set TZ=UTC for deterministic date handling');
  }

  let workers: Awaited<ReturnType<typeof startWorkers>> = [];
  if (config.ENABLE_QUEUE_WORKERS) {
    workers = await startWorkers();
  }

  initModels();
  await connectDB();

  // R-01: let /metrics report pool saturation. Registered here rather than
  // imported directly by the metrics module to keep that module free of a
  // database import (it is reached from error paths in the database layer).
  const { registerPoolMetricsSource } = await import('./infrastructure/metrics.js');
  registerPoolMetricsSource(sequelize);

  await Promise.all([
    initializeStorage(),
    ensureMeilisearchHealthy(),
    reportAntivirusReadiness(),
    reportKekReadiness(),
  ]);

  const app = createApp();
  const server = http.createServer(app);

  initializeSocket(server);
  initializeGateway();

  server.listen(config.PORT, config.HOST, () => {
    logger.info(
      { host: config.HOST, port: config.PORT },
      'dms api listening',
    );
  });

  if (config.ENABLE_OUTBOX_POLLING) {
    startOutboxPolling();
  }

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received; draining api process');
    const forceExit = setTimeout(() => {
      logger.error({ signal }, 'graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    stopOutboxPolling();
    await Promise.allSettled([
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      closeSocket(),
      Promise.allSettled(workers.map((worker) => worker.close())),
      sequelize.close(),
    ]);
    clearTimeout(forceExit);
    logger.info({ signal }, 'api process drained');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Last-resort safety net. Without these, ANY error that slips through —
  // most commonly a BullMQ Worker/Queue 'error' event with no listener (see
  // attachErrorLogger in infrastructure/queue/queues.ts, which is the real,
  // targeted fix for that specific case) — kills the process with nothing
  // logged at all: Node just exits, nodemon prints "app crashed", and
  // there's no stack trace anywhere to diagnose it from. That exact silent
  // pattern is what caused repeated unexplained backend crashes. This
  // doesn't try to keep the process running afterward — Node's own guidance
  // is that process state is undefined once uncaughtException fires, so it
  // still drains and exits via the same shutdown() path SIGTERM/SIGINT use
  // (bounded by that function's own 10s forced-exit timeout) — but now with
  // full diagnostics logged first, every time, instead of nothing.
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'uncaught exception — shutting down');
    void withDeadline(
      reportFatalCrash({ process: 'dms-api', errorName: error?.name ?? 'Error', errorMessage: error?.message ?? String(error) }),
      5_000,
    ).finally(() => void shutdown('uncaughtException'));
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ error: reason }, 'unhandled promise rejection — shutting down');
    const error = reason instanceof Error ? reason : undefined;
    void withDeadline(
      reportFatalCrash({ process: 'dms-api', errorName: error?.name ?? 'UnhandledRejection', errorMessage: error?.message ?? String(reason) }),
      5_000,
    ).finally(() => void shutdown('unhandledRejection'));
  });
}

bootstrap().catch((error) => {
  logger.fatal({ error }, 'fatal bootstrap failure');
  process.exit(1);
});
