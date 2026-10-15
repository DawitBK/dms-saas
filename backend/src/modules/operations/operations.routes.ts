// SPRINT-2/6: make health public and keep the remaining operations endpoints on permission-based protection.
import { Router } from "express";
import { Op, QueryTypes } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { authenticate, requirePermission, requireAnyPermission } from "../../shared/auth.js";
import { tenantContext } from "../../shared/middleware.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { DocumentDek, OutboxEvent, sequelize } from "../../infrastructure/database/index.js";
import { getCacheRedis } from "../../infrastructure/cache/redis.js";
import { getAntivirusStatus } from "../../infrastructure/antivirus/clamscan.js";
import { minioClient } from "../../infrastructure/storage/minio.js";
import { config, resolveVaultBackend } from "../../config/env.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { parseDevKekId } from "../../infrastructure/vault/VaultService.js";
import {
  outboxEventsProcessed,
  ocrProcessingDuration,
  aiProcessingDuration,
  counterByLabel,
  histogramAverageByLabel,
  readOcrOutcomeCounts,
  readAiOutcomeCounts,
} from "../../infrastructure/metrics.js";
import {
  alertingChannelStatus,
  clearSystemErrors,
  listSystemErrors,
  recordSystemError,
  sendTestAlert,
} from "../../infrastructure/alerting/adminAlerts.js";

export const operationsRoutes = Router();

// S1-01/06: Health endpoint is now public.
//
// R-01 load safety (2026-09-03). This endpoint had three separate problems
// that only show up under load, and it is the single most-polled route in the
// product: the dashboard landing page renders a system-health strip for EVERY
// signed-in user (frontend features/settings/hooks.ts useSystemHealth, 30s),
// so its request rate scales linearly with the number of people logged in.
//
//   1. Five real probes per request — a DB query, a Redis PING, a MinIO
//      bucketExists, an HTTP call to Meilisearch, and a COUNT over
//      outbox_events. At a few thousand concurrent users that is hundreds of
//      dependency round trips per second to render a status strip, and the
//      probes themselves became the load.
//   2. Run SERIALLY, so the response time was the SUM of five dependencies
//      and one slow dependency made the whole endpoint slow.
//   3. The Meilisearch fetch had NO timeout. A hung (as opposed to refused)
//      Meilisearch meant the request never completed, holding its socket
//      indefinitely — and since this route is deliberately public, an
//      unauthenticated caller could park connections that way for free.
//
// Fixed by decoupling the PROBE rate from the REQUEST rate. Results are cached
// briefly and shared, and concurrent callers on a cold cache collapse onto one
// in-flight probe instead of each starting their own. A burst of a thousand
// requests now costs one probe, and the response stays honest by reporting how
// old the sample is.
//
// Note on the poll itself: this is one of the few places where polling really
// is the right primitive rather than a fallback for a missing push. "Is Redis
// reachable" is a SAMPLED condition, not a domain event — there is nothing to
// emit, because a dependency going away does not announce itself. So the fix
// is to make the sample cheap, not to move it onto the socket.
const HEALTH_CACHE_TTL_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

type HealthSnapshot = Record<string, string>;

let healthCache: { at: number; value: HealthSnapshot } | null = null;
let healthProbeInFlight: Promise<HealthSnapshot> | null = null;

async function probeHealth(): Promise<HealthSnapshot> {
  // Every probe is independently bounded and independently caught, and they
  // run concurrently — so the endpoint's latency is the SLOWEST dependency,
  // not the sum of all of them, and one hung dependency cannot hold the
  // response open.
  const withTimeout = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} health probe timed out`)), HEALTH_PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const [db, redis, minio, meilisearch, outbox, workers, antivirus, vaultOwner] = await Promise.all([
    withTimeout("db", async () => {
      await sequelize.query("SELECT 1");
      return "ok";
    }).catch(() => "error"),

    withTimeout("redis", async () => {
      const client = getCacheRedis();
      if (!client) return "error";
      await client.ping();
      return "ok";
    }).catch(() => "error"),

    withTimeout("minio", async () => {
      await minioClient.bucketExists(config.MINIO_BUCKET_DOCUMENTS);
      return "ok";
    }).catch(() => "error"),

    withTimeout("meilisearch", async () => {
      if (!config.MEILISEARCH_HOST) return "error";
      // AbortSignal as well as the race above: without it the underlying
      // socket stays open even once we have stopped waiting for it.
      const resp = await fetch(`${config.MEILISEARCH_HOST}/health`, {
        headers: config.MEILISEARCH_MASTER_KEY
          ? { Authorization: `Bearer ${config.MEILISEARCH_MASTER_KEY}` }
          : undefined,
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      return resp.ok ? "ok" : "error";
    }).catch(() => "error"),

    withTimeout("outbox", async () => {
      const pending = await OutboxEvent.count({ where: { status: "PENDING" } });
      return String(pending);
    }).catch(() => null),

    // DATA-3: a healthy `redis: ok` above does NOT imply the workers
    // (retention purge, legal-hold disposal, SLA escalation) are actually
    // running — they only start once at process boot, in a SEPARATE OS
    // process from this one, and stay silently offline forever if
    // REDIS_URL was unset at that moment. Cross-process DB heartbeat, not
    // an in-memory flag (see workers/index.ts).
    // Dynamic import, not a static one: workers/index.ts statically pulls in
    // every worker module including OCRWorker.ts, which imports the ESM-only
    // `franc` package — a static import here broke Jest's CJS transform for
    // every test file that imports app.ts (acl.403/auth.401/permission.403),
    // which don't otherwise need anything worker-related at all.
    withTimeout("workers", async () => {
      const { getWorkerHealthStatus } = await import("../../infrastructure/queue/workers/index.js");
      return getWorkerHealthStatus();
    }).catch((err) => ({ ok: false as const, reason: String(err) })),

    // STOR-2: uploads keep succeeding either way (fail-open by policy, or
    // CLAMAV_ENABLED=false by deployment choice) — "nothing is being
    // scanned" has zero symptom by design, and until now was visible only
    // in a boot-time log line and the admin-only GET /operations/antivirus
    // pull. Surfaced here too so it rides the same continuously-polled
    // snapshot every other dependency does.
    withTimeout("antivirus", () => getAntivirusStatus()).catch((err) => ({
      enabled: false,
      reachable: false,
      cooldownActive: false,
      _error: String(err),
    })),

    // The platform-vault check functions are SECURITY DEFINER, so they run as their OWNER, and migration 20261004000002 revokes the vault tables
    // from the application role. If that migration was applied as the application role itself (no DB_MIGRATE_USER), the functions are owned by
    // the role it locked out, and every insert into user_roles then fails with "permission denied for table platform_vault_unlocked": no
    // symptom until someone assigns a role. Found on the mirror 2026-10-15; fix: scripts/fix-vault-function-owner.sql, run once as postgres.
    withTimeout("vaultOwner", async () => {
      const [rows] = (await sequelize.query(
        `SELECT (pg_get_userbyid(p.proowner) = current_user) AS owned_by_app,
                 COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS app_is_super
            FROM pg_proc p WHERE p.proname = 'platform_vault_is_unlocked' LIMIT 1`,
      )) as [Array<{ owned_by_app: boolean; app_is_super: boolean }>, unknown];
      const row = rows[0];
      if (!row) return "absent"; // a schema older than the vault migration
      return row.owned_by_app && !row.app_is_super ? "owned-by-app-role" : "ok";
    }).catch(() => "unknown"),
  ]);

  const health: HealthSnapshot = { db, redis, minio, meilisearch };
  if (outbox === null) {
    health.outbox = "error";
  } else {
    health.outbox = "ok";
    health.outboxPending = outbox;
  }

  health.workers = workers.ok ? "ok" : "error";
  if (!workers.ok && workers.reason) {
    health.workersOfflineReason = workers.reason;
  }

  // Three real states, not just ok/error — "disabled" (a deployment choice)
  // and "unreachable" (the dangerous, symptom-free one the finding is
  // actually about) need to read differently to anyone looking at this.
  health.antivirus = !antivirus.enabled ? "disabled" : antivirus.reachable ? "ok" : "unreachable";
  health.vaultOwner = vaultOwner;

  return health;
}

/**
 * A health snapshot no older than HEALTH_CACHE_TTL_MS, taking at most one
 * probe per TTL window no matter how many callers arrive.
 */
async function getHealthSnapshot(): Promise<{ health: HealthSnapshot; ageMs: number }> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_CACHE_TTL_MS) {
    return { health: healthCache.value, ageMs: now - healthCache.at };
  }

  // Single-flight. Without this, a cold cache under a burst starts one full
  // probe set PER request — the exact stampede the cache exists to prevent,
  // and worst precisely when dependencies are already struggling.
  if (!healthProbeInFlight) {
    healthProbeInFlight = probeHealth()
      .then((value) => {
        healthCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        healthProbeInFlight = null;
      });
  }

  const value = await healthProbeInFlight;
  return { health: value, ageMs: Math.max(0, Date.now() - (healthCache?.at ?? Date.now())) };
}

/** Test seam: drop the cached snapshot so a case starts cold. */
export function __resetHealthCache(): void {
  healthCache = null;
  healthProbeInFlight = null;
}

operationsRoutes.get("/health", asyncHandler(async (_req, res) => {
  const { health, ageMs } = await getHealthSnapshot();
  // Tell the caller how stale the sample is instead of implying it is live.
  // Additive — every existing field keeps its name and meaning.
  res.setHeader("Cache-Control", `public, max-age=${Math.floor(HEALTH_CACHE_TTL_MS / 1000)}`);
  res.json({ ...health, sampledAgoMs: String(ageMs) });
}));

// Readiness for an uptime monitor. /health above always answers 200 (the Operations screen reads its JSON
// whatever the state), so a monitor that only checks the status code can see a dead process but never a
// failed database or Redis, or a worker that has silently stopped. This answers 503 when any CRITICAL part
// has failed and 200 otherwise; `degraded` lists things that are wrong but do not stop the system (the
// antivirus scanner unreachable: uploads still succeed by policy). MinIO and Meilisearch are optional
// on some deployments and are deliberately not critical. No sign-in, no detail beyond component names.
const CRITICAL_COMPONENTS = ["db", "redis", "workers"] as const;
operationsRoutes.get("/ready", asyncHandler(async (_req, res) => {
  const { health } = await getHealthSnapshot();
  const failing = CRITICAL_COMPONENTS.filter((k) => health[k] === "error");
  const degraded = [
    ...(health.antivirus === "unreachable" ? ["antivirus"] : []),
    ...(health.vaultOwner === "owned-by-app-role" ? ["platform-vault-owner"] : []),
  ];
  res.setHeader("Cache-Control", "no-store");
  res.status(failing.length ? 503 : 200).json({ ok: failing.length === 0, failing, degraded });
}));

// Apply authentication to other operations routes
operationsRoutes.use(authenticate);
operationsRoutes.use(tenantContext);

// AUDIT: OPERATIONS_READ was granted to AUDITOR in ROLE_PERMISSIONS but never
// checked by any real endpoint (only OPERATIONS_MANAGE gated these two reads),
// making the grant decorative. requireAnyPermission so OPERATIONS_MANAGE
// holders keep working unchanged.
operationsRoutes.get("/outbox", requireAnyPermission(PERMISSIONS.OPERATIONS_READ, PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (_req, res) => {
  const events = await OutboxEvent.findAll({
    where: { status: { [Op.notIn]: ["DONE", "PROCESSED"] } },
    order: [["createdAt", "DESC"]],
    limit: 50,
    attributes: ["id", "type", "channel", "status", "attempts", "errorMsg", "createdAt", "processAfter"]
  });
  res.json({ data: events });
}));

operationsRoutes.post("/outbox/:id/retry", requirePermission(PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const event = await OutboxEvent.findByPk(id);
  if (!event) {
    throw new AppError(404, "ERR-OUTBOX-EVENT-NOT-FOUND", "Event not found");
  }
  await event.update({ status: "PENDING", attempts: 0, errorMsg: null, processAfter: new Date() });
  res.json({ success: true, event });
}));

// Read-only KEK-rotation / crypto-ops visibility (audit gap: rewrap-deks.ts is a
// CLI-only tool with no way to see whether a rotation is even needed without
// shelling into the box). Mirrors the dry-run accounting rewrap-deks.ts does,
// grouping document_deks by the KEK version embedded in their kekId. Like
// /outbox above, this is intentionally tenant-agnostic system-wide visibility
// (document_deks has no tenant_id column, same as outbox_events) and gated the
// same way (OPERATIONS_MANAGE).
operationsRoutes.get("/crypto-status", requireAnyPermission(PERMISSIONS.OPERATIONS_READ, PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (_req, res) => {
  const currentKekVersion = config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION;
  const rows = await DocumentDek.findAll({ attributes: ["kekId"], raw: true });

  const byVersion: Record<number, number> = {};
  let unparseable = 0;
  for (const row of rows as unknown as { kekId: string }[]) {
    try {
      const parsed = parseDevKekId(row.kekId);
      byVersion[parsed.version] = (byVersion[parsed.version] ?? 0) + 1;
    } catch {
      unparseable++;
    }
  }

  const behindCurrentVersion = Object.entries(byVersion)
    .filter(([version]) => Number(version) < currentKekVersion)
    .reduce((sum, [, count]) => sum + count, 0);

  res.json({
    data: {
      vaultMode: resolveVaultBackend() ?? "unconfigured",
      currentKekVersion,
      totalDeks: rows.length,
      byVersion,
      behindCurrentVersion,
      unparseableKekId: unparseable,
      rotationUpToDate: behindCurrentVersion === 0 && unparseable === 0,
      rewrapCommand: "npx tsx scripts/rewrap-deks.ts --execute",
    },
  });
}));

/** Split a "labelA:labelB" flat key (from counterByLabel/histogramAverageByLabel
 *  with two labelKeys) into a nested { labelA: { labelB: value } } object. */
function unflatten(flat: Record<string, number | null>): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {};
  for (const [key, value] of Object.entries(flat)) {
    const [a, b] = key.split(":");
    out[a] = out[a] ?? {};
    out[a][b] = value;
  }
  return out;
}

// Observability follow-up (2026-08-18): the OCR/AI BullMQ pipeline had no
// visibility beyond raw pino log lines — no counts of how many jobs
// completed/were skipped/failed anywhere an admin could see without shelling
// into the box and grepping. Backed by the prom-client counters/histograms in
// infrastructure/metrics.ts (wired up in OCRWorker.ts/AIWorker.ts/outbox.ts),
// read via their in-process .get() rather than scraping /metrics' Prometheus
// text format, since this is for a small JSON panel, not a real Prometheus
// scrape target. Same permission gate as /outbox — this is the same category
// of "is the background pipeline healthy" visibility.
operationsRoutes.get("/pipeline-metrics", requireAnyPermission(PERMISSIONS.OPERATIONS_READ, PERMISSIONS.OPERATIONS_MANAGE), asyncHandler(async (_req, res) => {
  // ocr/ai counts read from the Redis-backed cross-process store (see
  // infrastructure/metrics.ts) — the OCR/AI BullMQ workers run in a separate
  // process from this API process (ENABLE_QUEUE_WORKERS=false here), so an
  // in-process prom-client read would structurally always show 0 regardless
  // of how much real processing happened. Duration averages stay in-process
  // (prom-client) — they already report `null` rather than 0 when this
  // process has no samples, which is honest, just less complete; outbox
  // stays in-process too since its poller genuinely runs in this process.
  const [ocrResult, ocrAvgDuration, aiResult, aiAvgDurationFlat, outboxCountsFlat] = await Promise.all([
    readOcrOutcomeCounts(),
    histogramAverageByLabel(ocrProcessingDuration, ["outcome"]),
    readAiOutcomeCounts(),
    histogramAverageByLabel(aiProcessingDuration, ["operation"]),
    counterByLabel(outboxEventsProcessed, ["channel", "outcome"]),
  ]);

  const ocr = ocrResult.available
    ? { available: true, ...ocrResult.counts, avgDurationSeconds: ocrAvgDuration.completed ?? null }
    : { available: false, reason: ocrResult.reason };

  let ai: Record<string, unknown>;
  if (aiResult.available) {
    const aiByOperation = unflatten(aiResult.counts);
    for (const operation of Object.keys(aiByOperation)) {
      (aiByOperation[operation] as Record<string, number | null>).avgDurationSeconds = aiAvgDurationFlat[operation] ?? null;
    }
    ai = { available: true, ...aiByOperation };
  } else {
    ai = { available: false, reason: aiResult.reason };
  }

  res.json({
    data: {
      ocr,
      ai,
      outbox: unflatten(outboxCountsFlat),
    },
  });
}));

// Antivirus visibility. Added 2026-09-09: whether uploads are actually being
// scanned had no representation anywhere in the product -- only a line in the
// boot log. Because the scan policy is fail-OPEN (a file that cannot be
// scanned is still accepted and stamped `unscanned`), a dead clamd looks
// exactly like a working one from every screen in the app. This returns both
// halves of the answer: is the daemon there right now, and how much of what
// is already stored was genuinely scanned.
//
// Coverage runs after tenantContext, so RLS scopes `documents` to the
// caller's tenant; the daemon status itself is process-wide.
operationsRoutes.get(
  "/antivirus",
  requireAnyPermission(PERMISSIONS.OPERATIONS_READ, PERMISSIONS.OPERATIONS_MANAGE),
  asyncHandler(async (_req, res) => {
    const [scanner, coverageRows] = await Promise.all([
      getAntivirusStatus(),
      sequelize.query<{ av_scan_status: string | null; count: string }>(
        `SELECT dv.av_scan_status, COUNT(*)::text AS count
           FROM document_versions dv
           JOIN documents d ON d.id = dv.document_id
          WHERE d.deleted_at IS NULL
          GROUP BY dv.av_scan_status`,
        { type: QueryTypes.SELECT },
      ),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of coverageRows) byStatus[row.av_scan_status ?? "unknown"] = Number(row.count);
    const scanned = byStatus.clean ?? 0;
    const unscanned = byStatus.unscanned ?? 0;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    res.json({
      data: {
        scanner,
        coverage: {
          totalVersions: total,
          scanned,
          unscanned,
          byStatus,
          // Whole percent, or null when nothing is stored yet -- an empty
          // system must not read as "100% scanned".
          scannedPercent: total > 0 ? Math.round((scanned / total) * 100) : null,
        },
      },
    });
  }),
);

// System Errors: in-app visibility into the same unhandled 500s that trigger
// the Slack/email alerts (infrastructure/alerting/adminAlerts.ts), so "the
// team has been notified" is verifiable from the UI rather than taken on
// faith. Same permission gate as the rest of this file's admin-only reads.
operationsRoutes.get(
  "/system-errors",
  requireAnyPermission(PERMISSIONS.OPERATIONS_READ, PERMISSIONS.OPERATIONS_MANAGE),
  asyncHandler(async (_req, res) => {
    res.json({ data: listSystemErrors(), alerting: alertingChannelStatus() });
  }),
);

// Fires a real alert through every configured channel right now, bypassing
// the dedupe throttle, so an admin can confirm Slack/email actually arrive
// without waiting for (or manufacturing) a real production fault.
operationsRoutes.post(
  "/system-errors/test-alert",
  requirePermission(PERMISSIONS.OPERATIONS_MANAGE),
  asyncHandler(async (req, res) => {
    const result = await sendTestAlert(req.user?.userId ?? "unknown");
    res.json({ success: true, ...result });
  }),
);

operationsRoutes.post(
  "/system-errors/clear",
  requirePermission(PERMISSIONS.OPERATIONS_MANAGE),
  asyncHandler(async (_req, res) => {
    clearSystemErrors();
    res.json({ success: true });
  }),
);

// Frontend ErrorBoundary reporting (shared/components/ErrorBoundary.tsx) — a
// React render crash never reaches the backend's own error handler, so
// without this it was invisible to both the alerts above and this panel,
// despite the boundary's own comment promising "this would go to an error
// tracking service." Authenticated (like everything else in this file) but
// deliberately NOT permission-gated beyond that: any signed-in user's browser
// can hit a render crash, and it should still be reported.
operationsRoutes.post(
  "/client-error",
  asyncHandler(async (req, res) => {
    const { message, componentStack, route } = req.body ?? {};
    recordSystemError({
      method: "CLIENT",
      route: typeof route === "string" && route ? route : "unknown",
      errorName: "ClientRenderError",
      errorMessage: [typeof message === "string" ? message : "Unknown client error", componentStack]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000),
      requestId: req.id ?? "unknown",
      tenantId: req.user?.tenantId,
    });
    res.json({ success: true });
  }),
);
