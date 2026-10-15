// Prometheus metrics — real counters/histograms, replacing the scaffold string
// the /metrics route used to return. Default Node/process metrics plus a few
// DMS-specific series (HTTP request duration, outbox depth, audit writes).

import client from "prom-client";
import { getCacheRedis } from "./cache/redis.js";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "dms_" });

export const httpRequestDuration = new client.Histogram({
  name: "dms_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: "dms_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

// ── Realtime pipeline ──────────────────────────────────────────────────────
//
// The socket is the PRIMARY freshness mechanism for the UI; the frontend's
// interval polls are socket-down fallbacks. That makes "how many clients are
// actually on a live socket" an operational number, not a curiosity: a drop
// here is the whole estate silently falling back to polling, which shows up
// as an unexplained rise in request rate long before anyone reports staleness.
export const socketConnections = new client.Gauge({
  name: "dms_socket_connections",
  help: "Currently connected realtime sockets on this process",
  registers: [registry],
});

export const socketHandshakeRejections = new client.Counter({
  name: "dms_socket_handshake_rejections_total",
  help: "Realtime handshakes refused, by reason",
  labelNames: ["reason"] as const, // missing_token | invalid_token | revoked
  registers: [registry],
});

// ── Connection pool / admission control (R-01) ─────────────────────────────
//
// tenantContext holds one pooled DB connection for the FULL lifetime of every
// authenticated request, so the pool is the real concurrency ceiling and these
// are the numbers that say how close to it the process is running. Without
// them, pool exhaustion is invisible until it surfaces as user-visible
// timeouts with no way to tell whether the cause was the pool, the DB, or the
// app.
export const dbPoolSize = new client.Gauge({
  name: "dms_db_pool_size",
  help: "Connections currently held by the Sequelize pool (in use + idle)",
  registers: [registry],
});

export const dbPoolInUse = new client.Gauge({
  name: "dms_db_pool_in_use",
  help: "Pooled DB connections currently checked out",
  registers: [registry],
});

export const dbPoolWaiting = new client.Gauge({
  name: "dms_db_pool_waiting",
  help: "Requests queued waiting for a pooled DB connection",
  registers: [registry],
});

export const requestsInFlight = new client.Gauge({
  name: "dms_requests_in_flight",
  help: "Authenticated requests currently holding a tenant-scoped transaction",
  registers: [registry],
});

export const requestsShed = new client.Counter({
  name: "dms_requests_shed_total",
  help: "Requests refused with 503 by admission control rather than queued",
  labelNames: ["reason"] as const, // admission_limit | pool_timeout
  registers: [registry],
});

export const outboxEventsProcessed = new client.Counter({
  name: "dms_outbox_events_processed_total",
  help: "Outbox events processed, by channel and outcome",
  labelNames: ["channel", "outcome"] as const,
  registers: [registry],
});

export const auditWritesTotal = new client.Counter({
  name: "dms_audit_writes_total",
  help: "Audit log entries written",
  registers: [registry],
});

export const ocrJobsTotal = new client.Counter({
  name: "dms_ocr_jobs_total",
  help: "OCR_PROCESSING jobs completed, by outcome",
  labelNames: ["outcome"] as const, // completed | low_confidence | unsupported | failed
  registers: [registry],
});

export const ocrProcessingDuration = new client.Histogram({
  name: "dms_ocr_processing_duration_seconds",
  help: "OCR job wall-clock duration in seconds, by outcome",
  labelNames: ["outcome"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const aiJobsTotal = new client.Counter({
  name: "dms_ai_jobs_total",
  help: "AI_PROCESSING jobs completed, by operation and outcome",
  labelNames: ["operation", "outcome"] as const, // outcome: completed | skipped_insufficient_text | skipped_no_consent | failed
  registers: [registry],
});

export const aiProcessingDuration = new client.Histogram({
  name: "dms_ai_processing_duration_seconds",
  help: "AI job wall-clock duration in seconds, by operation",
  labelNames: ["operation"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/** Flatten a prom-client Counter/Histogram's current values into a plain
 *  object keyed by its label combination — for a small JSON API response
 *  instead of parsing the Prometheus text exposition format on the frontend. */
type LabelValue = Record<string, string | number | undefined>;

export async function counterByLabel(
  metric: { get(): Promise<{ values: Array<{ value: number; labels: LabelValue }> }> },
  labelKeys: string[],
): Promise<Record<string, number>> {
  const { values } = await metric.get();
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = labelKeys.map((k) => v.labels[k] ?? "unknown").join(":");
    out[key] = (out[key] ?? 0) + v.value;
  }
  return out;
}

/** Same idea for a Histogram's sum/count series (suffixed `_sum`/`_count` in
 *  prom-client's raw values) — returns { [labelKey]: averageSeconds }. */
export async function histogramAverageByLabel(
  metric: { get(): Promise<{ values: Array<{ value: number; labels: LabelValue; metricName?: string }> }> },
  labelKeys: string[],
): Promise<Record<string, number | null>> {
  const { values } = await metric.get();
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const v of values) {
    const key = labelKeys.map((k) => v.labels[k] ?? "unknown").join(":");
    if (v.metricName?.endsWith("_sum")) sums[key] = (sums[key] ?? 0) + v.value;
    if (v.metricName?.endsWith("_count")) counts[key] = (counts[key] ?? 0) + v.value;
  }
  const out: Record<string, number | null> = {};
  for (const key of new Set([...Object.keys(sums), ...Object.keys(counts)])) {
    out[key] = counts[key] ? sums[key] / counts[key] : null;
  }
  return out;
}

/** Express middleware: time every request and record method/route/status. */
export function metricsMiddleware(req: any, res: any, next: any): void {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    // Prefer the matched route pattern to avoid unbounded label cardinality
    // from path params (ids). Falls back to the raw path.
    const route = req.route?.path ?? req.baseUrl ?? req.path ?? "unknown";
    const labels = { method: req.method, route: String(route), status: String(res.statusCode) };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
}

/**
 * Sample the Sequelize pool into the gauges above.
 *
 * Read at scrape time rather than tracked on every acquire/release: the pool
 * already knows these numbers, and sampling avoids putting a metrics write on
 * the hot path of every query. Reached through `connectionManager.pool`, which
 * Sequelize 6 does not include in its published types — hence the cast, and
 * hence the try/catch: a metrics scrape must never be the thing that throws.
 */
function sampleDbPool(): void {
  try {
    const { sequelize } = pooledSequelize ?? {};
    const pool = (sequelize as unknown as { connectionManager?: { pool?: Record<string, number> } })
      ?.connectionManager?.pool;
    if (!pool) return;
    if (typeof pool.size === "number") dbPoolSize.set(pool.size);
    if (typeof pool.using === "number") dbPoolInUse.set(pool.using);
    if (typeof pool.waiting === "number") dbPoolWaiting.set(pool.waiting);
  } catch {
    // Leave the gauges at their last value rather than failing the scrape.
  }
}

// Lazily captured to avoid an import cycle: infrastructure/database imports
// config, which is fine, but metrics is imported from middleware which the
// database layer's own error paths reach. Set once from main.ts's bootstrap.
let pooledSequelize: { sequelize: unknown } | null = null;
export function registerPoolMetricsSource(sequelize: unknown): void {
  pooledSequelize = { sequelize };
}

export async function renderMetrics(): Promise<string> {
  sampleDbPool();
  return registry.metrics();
}

export const metricsContentType = registry.contentType;

// ── Cross-process job-outcome counters (Redis-backed) ──────────────────────
//
// The prom-client counters above (ocrJobsTotal, aiJobsTotal) are real and are
// genuinely `.inc()`'d by OCRWorker.ts/AIWorker.ts — but those run in a
// separate OS process from the API process that serves /operations/
// pipeline-metrics (ENABLE_QUEUE_WORKERS=false in the API process; workers
// run via bin/worker.ts instead). An in-process prom-client Registry has no
// cross-process backing, so reading it from the API process is structurally
// guaranteed to show 0 regardless of how much real processing the worker
// process has done. These wrappers additionally record the same outcome to
// Redis (which both processes can reach), and the read side reports
// unavailability explicitly rather than silently falling back to a
// number that would look like real data but isn't.
const REDIS_KEY_PREFIX = "dms:metrics:";

async function redisIncr(hashKey: string, field: string): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) return;
  try {
    await redis.hincrby(REDIS_KEY_PREFIX + hashKey, field, 1);
  } catch {
    // Best-effort: the in-process prom-client counter (still incremented by
    // the caller) is the only fallback signal if Redis is down — the read
    // side surfaces that as an explicit "unavailable" state, not a silent 0.
  }
}

type CountsResult =
  | { available: true; counts: Record<string, number> }
  | { available: false; reason: string };

async function redisReadHash(hashKey: string): Promise<CountsResult> {
  const redis = getCacheRedis();
  if (!redis) return { available: false, reason: "Metrics store (Redis) is not configured" };
  try {
    const raw = await redis.hgetall(REDIS_KEY_PREFIX + hashKey);
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) counts[k] = Number(v);
    return { available: true, counts };
  } catch {
    return { available: false, reason: "Metrics store (Redis) is unreachable" };
  }
}

/** Call from OCRWorker.ts instead of `ocrJobsTotal.inc(...)` directly. */
export async function recordOcrOutcome(outcome: string): Promise<void> {
  ocrJobsTotal.inc({ outcome });
  await redisIncr("ocr_jobs", outcome);
}

/** Call from AIWorker.ts instead of `aiJobsTotal.inc(...)` directly. */
export async function recordAiOutcome(operation: string, outcome: string): Promise<void> {
  aiJobsTotal.inc({ operation, outcome });
  await redisIncr("ai_jobs", `${operation}:${outcome}`);
}

/** Read real, cross-process OCR outcome counts for the pipeline-metrics panel. */
export async function readOcrOutcomeCounts(): Promise<CountsResult> {
  return redisReadHash("ocr_jobs");
}

/** Read real, cross-process AI outcome counts, keyed "operation:outcome". */
export async function readAiOutcomeCounts(): Promise<CountsResult> {
  return redisReadHash("ai_jobs");
}

/** Has any AI job for this operation ever recorded a "failed" outcome? Used
 *  to distinguish "never attempted" from "attempted and failed" for the
 *  document-detail AI summary card, reading the same cross-process store the
 *  pipeline panel uses instead of the in-process-only registry. */
export async function hasAiOperationEverFailed(operation: string): Promise<boolean> {
  const result = await redisReadHash("ai_jobs");
  if (!result.available) return false;
  return (result.counts[`${operation}:failed`] ?? 0) > 0;
}
