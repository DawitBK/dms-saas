import { setupLogger, logger } from "../core/logger.js";
import { assertProductionRuntimeRequirements } from "../config/env.js";
import { connectDB, initModels, sequelize } from "../infrastructure/database/index.js";
import { startWorkers } from "../infrastructure/queue/workers/index.js";
import { assertRedisVersion } from "../infrastructure/cache/redis.js";
import { reportFatalCrash } from "../infrastructure/alerting/adminAlerts.js";

/** Never let alerting itself delay a process that is already exiting. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

async function main() {
  setupLogger();
  assertProductionRuntimeRequirements();
  await assertRedisVersion();
  if (!process.env.TZ) {
    logger.warn("TZ is not set; set TZ=UTC for deterministic date handling");
  }
  initModels();
  await connectDB();

  const workers = await startWorkers();
  logger.info("dms worker running");

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown signal received - closing workers");
    const forceExit = setTimeout(() => {
      logger.error({ signal }, "graceful worker shutdown timed out");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    try {
      await Promise.allSettled(workers.map((w) => w.close()));
      await sequelize.close();
      logger.info("all workers closed");
    } catch (err) {
      logger.error({ err }, "error during worker shutdown");
    }
    clearTimeout(forceExit);
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Same safety net as main.ts's bootstrap() — log full diagnostics before
  // this process exits instead of vanishing silently. Now that workers run
  // in their own process (see DMS/CLAUDE.md), a crash here no longer takes
  // the API server down with it, but it should still never be a total
  // mystery why it happened.
  process.on("uncaughtException", (error) => {
    logger.fatal({ error }, "uncaught exception in worker process — shutting down");
    void withDeadline(
      reportFatalCrash({ process: "dms-worker", errorName: error?.name ?? "Error", errorMessage: error?.message ?? String(error) }),
      5_000,
    ).finally(() => void shutdown("uncaughtException"));
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ error: reason }, "unhandled promise rejection in worker process — shutting down");
    const error = reason instanceof Error ? reason : undefined;
    void withDeadline(
      reportFatalCrash({ process: "dms-worker", errorName: error?.name ?? "UnhandledRejection", errorMessage: error?.message ?? String(reason) }),
      5_000,
    ).finally(() => void shutdown("unhandledRejection"));
  });
}

main().catch((error) => {
  logger.fatal({ error }, "worker failed");
  process.exit(1);
});
