/**
 * Backs the ERR-INTERNAL response's "The team has been notified" text
 * (shared/middleware.ts) with an actual notification, plus in-app visibility
 * so an admin can verify the wiring from the UI instead of taking it on
 * faith. Before this module existed, the only thing that happened on an
 * unhandled 500 was a line written to the local pino log file — nobody was
 * notified of anything.
 *
 * Two independent, best-effort channels (each individually optional — see
 * config/env.ts for ADMIN_ALERT_WEBHOOK_URL / ADMIN_ALERT_EMAIL_TO):
 *   - Slack, via the same kind of incoming webhook the platform's
 *     uptime monitor already posts to (a different URL value is fine;
 *     pointing both at the same webhook just lands both in one channel).
 *   - Email, sent directly through the existing mailer — NOT the
 *     transactional outbox, deliberately: the outbox needs a DB transaction,
 *     and a DB-capacity fault is exactly one of the things this alerts on.
 *
 * Errors are deduped per (method + route + error name) "fingerprint" so one
 * flapping bug sends one alert per ADMIN_ALERT_THROTTLE_MS window rather than
 * one per request — the same state-change-only philosophy the platform's uptime monitor
 * uses for up/down transitions. The in-memory tracker still records every
 * occurrence's count regardless of whether that occurrence triggered a
 * fresh alert, so the /operations panel shows the true frequency.
 *
 * Deliberately in-process memory, not a DB table: this exists to survive the
 * exact moment the database might be the thing that's broken.
 */
import { config } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { sendEmail } from "../email/mailer.js";
import { renderEmail } from "../email/templates.js";

export interface SystemErrorRecord {
  fingerprint: string;
  method: string;
  route: string;
  errorName: string;
  errorMessage: string;
  requestId: string;
  tenantId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  lastAlertedAt: string | null;
}

// Cap on distinct fingerprints tracked at once. A real deployment has a
// bounded number of routes, so this is defensive against something
// pathological (a route templated with raw user input) rather than a limit
// expected to bite in practice.
const MAX_TRACKED_FINGERPRINTS = 200;

const errors = new Map<string, SystemErrorRecord>();

function evictOldestIfNeeded() {
  if (errors.size <= MAX_TRACKED_FINGERPRINTS) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, rec] of errors) {
    const at = new Date(rec.lastSeenAt).getTime();
    if (at < oldestAt) {
      oldestAt = at;
      oldestKey = key;
    }
  }
  if (oldestKey) errors.delete(oldestKey);
}

async function postSlackAlert(text: string): Promise<void> {
  if (!config.ADMIN_ALERT_WEBHOOK_URL) return;
  try {
    const res = await fetch(config.ADMIN_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[DMS] ${text}` }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[adminAlerts] Slack webhook responded with a non-OK status");
    }
  } catch (err) {
    // Never let an alerting failure become a second unhandled error.
    logger.warn({ error: err }, "[adminAlerts] failed to deliver Slack alert");
  }
}

async function sendEmailAlert(record: SystemErrorRecord): Promise<void> {
  if (!config.ADMIN_ALERT_EMAIL_TO) return;
  try {
    const to = config.ADMIN_ALERT_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) return;
    const rendered = renderEmail("SYSTEM.UNHANDLED_ERROR", {
      method: record.method,
      route: record.route,
      errorName: record.errorName,
      errorMessage: record.errorMessage,
      requestId: record.requestId,
      tenantId: record.tenantId,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      occurrenceCount: record.count,
      throttleMinutes: Math.round(config.ADMIN_ALERT_THROTTLE_MS / 60_000),
    });
    await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text });
  } catch (err) {
    logger.warn({ error: err }, "[adminAlerts] failed to deliver email alert");
  }
}

export interface RecordSystemErrorInput {
  method: string;
  route: string;
  errorName: string;
  errorMessage: string;
  requestId: string;
  tenantId?: string;
}

/**
 * Called from every fault surface this platform has: the global HTTP error
 * handler (ERR-INTERNAL, DB-capacity 503s, admission-limit 503s — shared/
 * middleware.ts), the frontend's ErrorBoundary AND its global window.onerror/
 * onunhandledrejection listener (via POST /operations/client-error — neither
 * kind of frontend fault reaches this backend any other way), permanently
 * failed outbox deliveries (infrastructure/queue/outbox.ts), and — via
 * reportFatalCrash below — a process-level uncaughtException/
 * unhandledRejection in either the API or the worker process. One system,
 * every layer: frontend, backend, DB, background jobs.
 *
 * Fire-and-forget by default (returns a Promise callers may ignore): must
 * never throw, and must never slow down or fail the response that already
 * went out to the caller. `bypassThrottle` is for reportFatalCrash, where the
 * caller DOES await the returned promise (with its own timeout) because the
 * process is about to exit and this is the last chance to send it.
 */
export function recordSystemError(
  input: RecordSystemErrorInput,
  opts: { bypassThrottle?: boolean } = {},
): Promise<void> {
  const fingerprint = `${input.method} ${input.route} :: ${input.errorName}`;
  const now = new Date().toISOString();

  let record = errors.get(fingerprint);
  if (!record) {
    record = {
      fingerprint,
      method: input.method,
      route: input.route,
      errorName: input.errorName,
      errorMessage: input.errorMessage,
      requestId: input.requestId,
      tenantId: input.tenantId,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      lastAlertedAt: null,
    };
    errors.set(fingerprint, record);
    evictOldestIfNeeded();
  } else {
    record.count += 1;
    record.lastSeenAt = now;
    record.errorMessage = input.errorMessage;
    record.requestId = input.requestId;
    record.tenantId = input.tenantId;
  }

  // Jest's test env deliberately reuses .env.development for most values
  // (tests/setup-env.cjs), so ADMIN_ALERT_EMAIL_TO/WEBHOOK_URL set there for
  // real dev use would otherwise leak into every test run. This suite
  // exercises 500/503/dead-letter/job-failure paths constantly — that
  // regressed the full run from ~11s to a multi-minute stall the moment
  // ADMIN_ALERT_EMAIL_TO was added to .env.development, from real SMTP
  // connections and nodemailer's pooled 5-msg/sec rate limiter serializing
  // hundreds of test-triggered "alerts". Recording into the in-memory map
  // above still happens (harmless, no I/O) so a future test COULD assert on
  // it; only the actual network dispatch is suppressed.
  const hasAnyChannel =
    config.NODE_ENV !== "test" &&
    (Boolean(config.ADMIN_ALERT_WEBHOOK_URL) || Boolean(config.ADMIN_ALERT_EMAIL_TO));
  if (!hasAnyChannel) return Promise.resolve();

  const throttleMs = config.ADMIN_ALERT_THROTTLE_MS;
  const shouldAlert =
    opts.bypassThrottle ||
    !record.lastAlertedAt ||
    Date.now() - new Date(record.lastAlertedAt).getTime() > throttleMs;
  if (!shouldAlert) return Promise.resolve();

  record.lastAlertedAt = now;
  const summary = `Unhandled error on ${record.method} ${record.route}: ${record.errorName} — ${record.errorMessage} (requestId ${record.requestId}${record.tenantId ? `, tenant ${record.tenantId}` : ""})`;
  return Promise.all([postSlackAlert(summary), sendEmailAlert(record)]).then(() => {});
}

export interface ReportFatalCrashInput {
  /** Which process crashed: "dms-api" or "dms-worker". */
  process: string;
  errorName: string;
  errorMessage: string;
}

/**
 * A process-level uncaughtException/unhandledRejection is the single most
 * severe fault this platform can have — the process is about to exit, and if
 * this alert doesn't go out NOW, nobody finds out until someone notices the
 * service is down. Always bypasses the throttle (a crash is rare enough that
 * deduping it is never the right call) and the caller is expected to AWAIT
 * the returned promise, raced against its own short timeout, before
 * completing shutdown.
 */
export function reportFatalCrash(input: ReportFatalCrashInput): Promise<void> {
  return recordSystemError(
    {
      method: "PROCESS",
      route: input.process,
      errorName: input.errorName,
      errorMessage: input.errorMessage,
      requestId: "n/a",
    },
    { bypassThrottle: true },
  );
}

/** For the /operations "System Errors" panel — newest-seen first. */
export function listSystemErrors(): SystemErrorRecord[] {
  return Array.from(errors.values()).sort(
    (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
  );
}

export function clearSystemErrors(): void {
  errors.clear();
}

export function alertingChannelStatus() {
  return {
    slackConfigured: Boolean(config.ADMIN_ALERT_WEBHOOK_URL),
    emailConfigured: Boolean(config.ADMIN_ALERT_EMAIL_TO),
    throttleMs: config.ADMIN_ALERT_THROTTLE_MS,
  };
}

/** Fires a real alert through every configured channel unconditionally
 *  (bypassing the throttle) so an admin can confirm delivery from the UI. */
export async function sendTestAlert(triggeredBy: string): Promise<{ slackAttempted: boolean; emailAttempted: boolean }> {
  const text = `Test alert triggered manually by ${triggeredBy} from the DMS Operations → System Errors panel. If you can see this, alerting is wired correctly.`;
  const slackAttempted = Boolean(config.ADMIN_ALERT_WEBHOOK_URL);
  const emailAttempted = Boolean(config.ADMIN_ALERT_EMAIL_TO);
  await Promise.all([
    postSlackAlert(text),
    sendEmailAlert({
      fingerprint: "test",
      method: "TEST",
      route: "/operations/system-errors/test-alert",
      errorName: "TestAlert",
      errorMessage: text,
      requestId: "test",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      count: 1,
      lastAlertedAt: null,
    }),
  ]);
  return { slackAttempted, emailAttempted };
}
