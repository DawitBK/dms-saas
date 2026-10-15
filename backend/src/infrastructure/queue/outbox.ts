import { notPlatformAdminSql } from "../../shared/platformAdmin.js";
import crypto from "node:crypto";
import { Op, QueryTypes, UniqueConstraintError } from "sequelize";
import { OutboxEvent, WebhookSubscription, User, Document, DocumentVersion, WorkflowTask, sequelize } from "../database/index.js";
import { logger } from "../../core/logger.js";
import { config } from "../../config/env.js";
import { createQueue } from "./queues.js";
import { emitDomainEvent } from "../websocket/socket.js";
import { sendEmail } from "../email/mailer.js";
import { renderEmail } from "../email/templates.js";
import { getCacheRedis } from "../cache/redis.js";
import { fetchAndDecrypt } from "../../modules/documents/documentCrypto.js";
import { redactOutboxPayload } from "../../modules/esigning/esignTokens.js";
import { assertResolvesToPublicAddress, safeWebhookRequest } from "../../shared/ssrf.js";
import { withWorkerTenantContext } from "../../shared/workerTenantContext.js";
import { outboxEventsProcessed } from "../metrics.js";
import { recordSystemError } from "../alerting/adminAlerts.js";

// EMAIL and WEBSOCKET channels had no redelivery dedupe at all (unlike
// WEBHOOK's X-EDMS-Event-Id header and OCR/SEARCH_INDEX's BullMQ jobId). If
// the same row is ever legitimately redelivered — e.g. a DB blip right after
// a successful send but before the row is marked PROCESSED — the recipient
// gets a duplicate email or socket event. A Redis key with a TTL slightly
// longer than the outbox's own retry window gives a cheap per-event-id dedupe
// guard; fails open (dispatches without the guard) if Redis is down, consistent
// with this app's Redis-optional posture elsewhere.
//
// Uses getCacheRedis() (fail-fast: maxRetriesPerRequest 1, connectTimeout
// 2000ms), never getRedis()'s BullMQ client — that one's infinite-patience
// settings mean a plain exists/set call issued while Redis is down would
// hang forever instead of failing open the way the comment above promises,
// leaving this event's processEvent promise pending inside Promise.allSettled
// and the outbox row stuck in PROCESSING until the next 5-minute reclaim.
//
// CRITICAL ordering: the guard is CHECKED before dispatch but only SET *after* a
// successful send. Setting it before the send (SETNX) would turn the outbox's
// at-least-once contract into at-most-once — a transient SMTP failure claims the
// key, then every backoff retry (30s/2m/8m, all inside the 1h TTL) sees the key,
// skips, and the row is marked PROCESSED anyway, silently losing the email
// forever. Check-then-set-on-success keeps the retry alive on failure and only
// suppresses a genuine post-success redelivery.
//
// FAILING OPEN IS THE WHOLE POINT, AND IT DID NOT.
//
// `if (!redis) return false` only covers Redis being *unconfigured*. With
// REDIS_URL set and the server merely DOWN, getCacheRedis() hands back a live
// client whose enableOfflineQueue is false, so `exists` REJECTS with "Stream
// isn't writeable and enableOfflineQueue options is false" — thrown from the
// first line of the EMAIL and WEBSOCKET branches, before either one attempts
// any delivery. processEvent's catch then counts it as a failed dispatch, so
// the row burns all three attempts on a dedupe lookup and lands in
// DEAD_LETTER having never touched SMTP or socket.io.
//
// That is not hypothetical: it dead-lettered 7,551 WEBSOCKET and 1,540 EMAIL
// events on the dev database over the two months Redis was not running, all
// carrying that one error string. Every one of those looked like a broken
// email/notification subsystem and was in fact a cache lookup for an
// optimisation.
//
// A dedupe guard is advisory. When it is unavailable the correct degrade is
// "assume not yet dispatched" — the outbox contract is at-least-once, so a
// duplicate on redelivery is within spec and a lost notification is not.
async function hasDispatched(channel: string, eventId: string): Promise<boolean> {
  const redis = getCacheRedis();
  if (!redis) return false;
  const key = `dms:outbox:dispatched:${channel}:${eventId}`;
  try {
    return (await redis.exists(key)) === 1;
  } catch (error) {
    logger.warn(
      { error, eventId, channel },
      "[outbox] dedupe guard unreadable (Redis down) — treating event as not yet dispatched and delivering it",
    );
    return false;
  }
}

async function markDispatched(channel: string, eventId: string): Promise<void> {
  const redis = getCacheRedis();
  if (!redis) return;
  const key = `dms:outbox:dispatched:${channel}:${eventId}`;
  try {
    await redis.set(key, "1", "EX", 3600);
  } catch (error) {
    // Deliberately swallowed. The delivery already succeeded; throwing here
    // would fail the row and retry a send that actually went out.
    logger.warn(
      { error, eventId, channel },
      "[outbox] could not record dedupe guard (Redis down) — a redelivery of this event may duplicate",
    );
  }
}

const ocrQueue = createQueue("OCR_PROCESSING");
const searchQueue = createQueue("SEARCH_INDEX");

/**
 * Domain event types that are fanned out to external webhook subscribers.
 * A non-WEBHOOK outbox event of one of these types spawns a dedicated,
 * independently-retried WEBHOOK outbox row on first processing.
 */
const WEBHOOK_EVENT_TYPES = new Set<string>([
  "DOCUMENT.CREATED",
  "DOCUMENT.STATUS_CHANGED",
  "DOCUMENT.VERSION_UPLOADED",
  "DOCUMENT.HOLD_APPLIED",
  "DOCUMENT.HOLD_RELEASED",
  "WORKFLOW.STARTED",
  "RETENTION.DISPOSAL_PENDING",
  "RETENTION.DISPOSAL_EXECUTED",
]);

/**
 * Enqueue a WEBSOCKET outbox event from any process (API or worker).
 *
 * Workers run in a separate process where Socket.IO is not initialised, so they
 * cannot call emitDomainEvent directly.  Writing a WEBSOCKET row here lets the
 * API-process outbox poller do the actual emit.  Include departmentId so the
 * event is routed to the correct department room; omit it to fall back to the
 * admin room.
 */
export async function enqueueWebsocketEvent(
  type: string,
  payload: { documentId?: string; departmentId?: string | null; tenantId?: string; recipientUserIds?: string[]; [k: string]: unknown },
): Promise<void> {
  await OutboxEvent.create({
    documentId: payload.documentId ?? null,
    type,
    channel: "WEBSOCKET",
    payload: JSON.stringify(payload),
  });
}

/** How long a PROCESSING row may sit before it is considered abandoned.
 *  Shared by the reclaim branch of the claim query and the terminal sweep
 *  below, so the two can never disagree about what "stuck" means. */
const STUCK_PROCESSING_MINUTES = 5;

// ── Event expiry, per channel ──────────────────────────────────────────────
//
// The outbox has no notion of an event going stale: a row queued two months ago
// is delivered the instant a worker can reach its transport again. That is
// correct for durable work and actively harmful for a notification.
//
// It is not hypothetical. Redis was down for two months on the dev box, which
// (before the dedupe fail-open fix above) parked ~35,000 events. The moment
// SMTP was pointed at the real relay to test it, the poller began relaying
// months-old alerts in bulk — 95 went out and 133 authenticated logins in a few
// minutes was enough for Gmail to answer `454-4.7.0 Too many login attempts`
// and temporarily block the account all four Example Corp systems send through.
// On this deployment that is an outage of every system's outbound mail, caused
// entirely by notifications nobody wanted any more.
//
// So expiry is per channel, by what the payload is actually for:
//
//   WEBSOCKET     A live UI nudge. An hour late it is not merely useless, it is
//                 wrong — the client that would have consumed it is long gone
//                 and every page refetches on mount anyway.
//   EMAIL         "An approval is waiting for you" is still true tomorrow, so
//                 this window is generous. It exists to bound a flood, not to
//                 suppress genuine mail.
//   WEBHOOK       External consumers dedupe on X-EDMS-Event-Id; a days-old
//                 delivery is more likely to confuse than to inform.
//   OCR           NEVER expires, and must not. These are durable work orders
//   SEARCH_INDEX  ("extract text from this document", "index this document"),
//                 not notifications. Expiring one leaves a document permanently
//                 unsearchable with nothing to say why.
const CHANNEL_MAX_AGE_HOURS: Record<string, number> = {
  WEBSOCKET: 1,
  EMAIL: config.OUTBOX_EMAIL_MAX_AGE_HOURS,
  WEBHOOK: 72,
};

// PROCESSED rows are pure history — the audit log, not this table, is the
// record of what happened. Nothing has ever deleted them: 46,200 rows and 24 MB
// on the dev database, growing with every websocket event forever. DEAD_LETTER
// rows are kept far longer because they are an operator's evidence and the
// /operations/outbox retry surface reads them.
const PRUNE_PROCESSED_DAYS = 7;
const PRUNE_DEAD_LETTER_DAYS = 90;
// Housekeeping runs on the 5-second poller, so it needs its own much slower
// clock or it is 720 pointless DELETEs an hour.
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
let lastHousekeepingAt = 0;

/**
 * Retire PROCESSING rows that are stuck AND out of retries.
 *
 * THE LEAK THIS CLOSES
 *
 * The claim query below filters on `attempts < max_attempts` at the TOP level,
 * so that condition applies to its PROCESSING reclaim branch too. A row whose
 * worker died on its LAST attempt is therefore invisible to it forever: it is
 * never reclaimed (no attempts left) and never dead-lettered (only the failure
 * handler does that, and that worker is gone). It just sits in PROCESSING
 * permanently — 56 of them on the dev database.
 *
 * That is not merely untidy. PROCESSING is the "in flight" state, so these rows
 * read as work still being done. Notifications, emails and every realtime event
 * ride this outbox, and an operator looking at the queue cannot distinguish a
 * genuinely busy row from one abandoned weeks ago.
 *
 * DEAD_LETTER is the honest terminal state: it is exactly where the failure
 * handler would have put them had the worker lived long enough to run it, and
 * it is the state /operations/outbox already exposes for retry.
 *
 * Deliberately NOT given another attempt. The attempts were spent; handing back
 * a free retry because a process happened to die would let a poison event cycle
 * indefinitely, which is the thing max_attempts exists to prevent.
 *
 * Exported for test-scripts/verify-outbox-abandoned-sweep.ts, which plants a
 * genuinely stuck row and proves this retires it — and proves it leaves a
 * still-retryable one alone. Calling processOutbox() instead would also dispatch
 * live events, which is not what that test is about.
 */
export async function retireAbandonedProcessingEvents(): Promise<void> {
  try {
    const [affected] = await OutboxEvent.update(
      {
        status: "DEAD_LETTER",
        errorMsg:
          "Abandoned in PROCESSING with no retries left — the worker holding it did not finish. Retired by the outbox sweep.",
      },
      {
        where: {
          status: "PROCESSING",
          // Both comparisons are raw SQL on purpose.
          //
          // `attempts: { [Op.gte]: sequelize.col("max_attempts") }` looks right
          // and type-checks, but Sequelize does not render it as a
          // column-to-column comparison here — it silently matched NOTHING,
          // verified against a database that had 5 qualifying rows. A sweep
          // that quietly matches nothing is worse than no sweep, because the
          // leak looks fixed.
          [Op.and]: [
            sequelize.literal("attempts >= max_attempts"),
            sequelize.literal(
              `processing_started_at <= NOW() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes'`,
            ),
          ],
        },
      },
    );
    if (affected && affected > 0) {
      outboxEventsProcessed.inc({ channel: "unknown", outcome: "dead_letter" }, affected);
      logger.error(
        { count: affected },
        "[outbox] DEAD_LETTER — retired events abandoned in PROCESSING with no retries left",
      );
      recordSystemError({
        method: "OUTBOX",
        route: "abandoned-processing-sweep",
        errorName: "OutboxAbandonedInProcessing",
        errorMessage: `${affected} event(s) abandoned in PROCESSING with no retries left — the worker holding them did not finish`,
        requestId: "n/a",
      });
    }
  } catch (error) {
    // Never let the sweep take the poller down: draining live events matters
    // more than retiring dead ones.
    logger.warn({ error }, "[outbox] could not sweep abandoned PROCESSING events");
  }
}

/**
 * Retire notification events that have outlived their usefulness.
 *
 * DEAD_LETTER rather than DELETE on purpose: an operator asking "why did this
 * approval never email anyone?" gets an answer with a reason string, not a
 * missing row. The reason names the age so it cannot be mistaken for a
 * delivery failure.
 *
 * OCR and SEARCH_INDEX are absent from CHANNEL_MAX_AGE_HOURS and are therefore
 * never touched — see the note there.
 */
export async function expireStaleEvents(): Promise<void> {
  for (const [channel, maxAgeHours] of Object.entries(CHANNEL_MAX_AGE_HOURS)) {
    try {
      const [affected] = await OutboxEvent.update(
        {
          status: "DEAD_LETTER",
          errorMsg:
            `Expired unsent after ${maxAgeHours}h. A ${channel} event this old has outlived what it was for, ` +
            `and delivering a backlog of them at once is its own incident.`,
        },
        {
          where: {
            channel,
            status: { [Op.in]: ["PENDING", "FAILED"] },
            [Op.and]: [sequelize.literal(`created_at <= NOW() - INTERVAL '${maxAgeHours} hours'`)],
          },
        },
      );
      if (affected && affected > 0) {
        outboxEventsProcessed.inc({ channel, outcome: "expired" }, affected);
        logger.warn(
          { channel, count: affected, maxAgeHours },
          "[outbox] expired stale events — they were never delivered",
        );
      }
    } catch (error) {
      // Housekeeping must never take the poller down; draining live events
      // matters more than tidying dead ones.
      logger.warn({ error, channel }, "[outbox] could not expire stale events");
    }
  }
}

/**
 * Delete outbox history that is past its usefulness.
 *
 * Bounded by LIMIT so one call can never turn into a multi-minute DELETE that
 * blocks the poller behind it — a table this size only becomes a problem
 * because nothing was trimming it, and catching up gradually is fine.
 */
export async function pruneOutboxHistory(): Promise<void> {
  try {
    // RETURNING id + QueryTypes.SELECT, not a bare DELETE. Sequelize hands back
    // [[], metadata] for a plain DELETE on Postgres, so counting the first
    // element reports 0 however many rows went — a prune that looks like a
    // no-op forever. Same shape of mistake as the sequelize.col() predicate
    // above: it type-checks, reads correctly, and is silently wrong.
    const deletedRows = await sequelize.query<{ id: string }>(
      `DELETE FROM outbox_events
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE (status = 'PROCESSED'   AND created_at <= NOW() - INTERVAL '${PRUNE_PROCESSED_DAYS} days')
              OR (status = 'DEAD_LETTER' AND created_at <= NOW() - INTERVAL '${PRUNE_DEAD_LETTER_DAYS} days')
           LIMIT 5000
        )
        RETURNING id`,
      { type: QueryTypes.SELECT },
    );
    const deleted = deletedRows.length;
    if (deleted > 0) logger.info({ deleted }, "[outbox] pruned delivered/dead history");
  } catch (error) {
    logger.warn({ error }, "[outbox] could not prune history");
  }
}

export async function processOutbox() {
  if (!config.ENABLE_OUTBOX_POLLING) return;

  // Before claiming: retire anything abandoned in PROCESSING with no retries
  // left. The claim query cannot see those rows (see the note there), so
  // nothing else would ever move them out of an "in flight" state.
  await retireAbandonedProcessingEvents();

  // Expiry runs on every tick, deliberately. It is the guard that stops a
  // recovered transport from flushing a backlog, so it has to have run BEFORE
  // the claim below — an hourly schedule would leave a window in which exactly
  // the flood this prevents can still happen. It is a single indexed UPDATE
  // that matches nothing on a healthy queue.
  await expireStaleEvents();

  // Pruning is pure housekeeping and only needs its own slow clock.
  if (Date.now() - lastHousekeepingAt > HOUSEKEEPING_INTERVAL_MS) {
    lastHousekeepingAt = Date.now();
    await pruneOutboxHistory();
  }

  try {
    // Atomically claim events using FOR UPDATE SKIP LOCKED so that multiple
    // poller instances never process the same event concurrently.
    //   - PENDING: fresh events, due now.
    //   - FAILED:  transient failures still under maxAttempts — retried after
    //     an exponential backoff window (process_after was pushed forward).
    //   - PROCESSING: reclaimed if stuck > 5 min (a crashed poller left them),
    //     so a hard-kill mid-batch never strands events forever.
    //
    // NOTE the `attempts < max_attempts` guard applies to ALL THREE branches,
    // including the reclaim — so a row whose worker died on its last attempt is
    // invisible here by design. retireAbandonedProcessingEvents() above is what
    // gives those rows a terminal state; without it they sat in PROCESSING
    // forever, looking like work still in flight.
    //
    // FIX: the PROCESSING branch used to check `process_after <= NOW() -
    // 5min` — process_after is roughly the row's ORIGINAL due time, not when
    // this processing attempt actually started. A dispatch that's simply
    // slow (not stuck) got reclaimed and re-dispatched concurrently with
    // itself, burning a retry attempt each time — a healthy-but-slow event
    // could exhaust all 3 attempts purely for taking >5 min. Anchor to
    // processing_started_at, stamped fresh on every claim, instead.
    const events = await sequelize.transaction(async (t) => {
      const rows = await sequelize.query<{ id: string }>(
        `SELECT id FROM outbox_events
         WHERE attempts < max_attempts
           AND (
             (status IN ('PENDING','FAILED') AND process_after <= NOW())
             OR (status = 'PROCESSING' AND processing_started_at <= NOW() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes')
           )
         ORDER BY created_at ASC
         LIMIT 20
         FOR UPDATE SKIP LOCKED`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      if (rows.length === 0) return [];
      const ids = rows.map(r => r.id);
      await OutboxEvent.update(
        { status: "PROCESSING", attempts: sequelize.literal("attempts + 1") as any, processingStartedAt: new Date() },
        { where: { id: ids }, transaction: t }
      );
      return OutboxEvent.findAll({ where: { id: ids }, transaction: t });
    });

    if (events.length === 0) return;

    // Process events in parallel, up to 5 concurrently
    const CONCURRENCY = 5;
    for (let i = 0; i < events.length; i += CONCURRENCY) {
      await Promise.allSettled(
        events.slice(i, i + CONCURRENCY).map(event => processEvent(event))
      );
    }
  } catch (error) {
    logger.error({ error }, "outbox polling failed");
  }
}

async function deliverWebhookEvent(event: OutboxEvent) {
  const payload = JSON.parse(event.payload);
  const tenantId: string | undefined = payload.tenantId;

  // Tenant scoping is mandatory: an event must only ever reach subscribers
  // belonging to the same tenant. Without a tenantId we cannot scope safely.
  if (!tenantId) {
    logger.warn(
      { eventId: event.id, type: event.type },
      "[outbox] WEBHOOK event has no tenantId — refusing to deliver (would cross tenants)"
    );
    return;
  }

  // webhook_subscriptions is RLS-protected with NO unset-GUC escape valve: a
  // bare read from this GUC-less poller returns zero rows the day the DB role
  // switches to edams_app — every webhook silently stops delivering. Scope the
  // read under the event's tenant like the workers do.
  const subscriptions = await withWorkerTenantContext(tenantId, () =>
    WebhookSubscription.findAll({ where: { isActive: true, tenantId } })
  );

  if (subscriptions.length === 0) {
    logger.debug({ eventId: event.id, tenantId, type: event.type }, "[outbox] no active webhook subscriptions for tenant");
    return;
  }

  // Deliver to every subscription independently — one failing endpoint must
  // not block the others. Delivery is at-least-once: on retry, already-
  // delivered endpoints receive the event again, so consumers dedupe using
  // the X-EDMS-Event-Id header.
  const failures: string[] = [];
  for (const sub of subscriptions) {
    const signature = crypto.createHmac("sha256", sub.secret).update(event.payload).digest("hex");
    try {
      // Fast-fail pre-flight (clear error, no socket opened). The AUTHORITATIVE
      // SSRF gate is the connect-time DNS lookup inside safeWebhookRequest, which
      // validates every resolved address and pins the socket to it — closing the
      // DNS-rebinding (TOCTOU) window that a separate resolve-then-fetch leaves
      // open, because fetch()/undici re-resolves the hostname independently.
      // safeWebhookRequest also never follows redirects, so a public endpoint
      // cannot 30x-bounce us to an internal one.
      await assertResolvesToPublicAddress(sub.url);
      const response = await safeWebhookRequest(sub.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-EDMS-Event-Id": event.id,
          "X-EDMS-Event-Type": event.type,
          "X-EDMS-Signature": signature
        },
        body: event.payload,
        timeoutMs: 10000 // 10s SLA timeout
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      logger.info({ eventId: event.id, subscriptionId: sub.id, url: sub.url }, "[outbox] webhook delivered");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ error: reason, subscriptionId: sub.id, url: sub.url }, "[outbox] webhook delivery failed");
      failures.push(`${sub.url}: ${reason}`);
    }
  }

  // Surface partial failure so the outbox retries the row (up to maxAttempts).
  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${subscriptions.length} webhook deliveries failed: ${failures.join("; ")}`
    );
  }
}

/**
 * Spawns a dedicated WEBHOOK outbox row for a domain event so external
 * delivery is retried independently of the event's primary channel.
 * Resolves the tenant from the document when the source payload omits it.
 * Best-effort: never throws into the primary processing path.
 *
 * IDEMPOTENT by construction, not by caller discipline: this may legitimately
 * be called more than once for the same source event (a reclaimed row whose
 * `attempts` was bumped by the atomic claim in processOutbox before a crash
 * ever let this function run the first time — see processEvent's call site).
 * `source_event_id` plus a partial unique index on it (WHERE channel =
 * 'WEBHOOK') means at most one fan-out row can ever exist per source event:
 * the existence check below handles the common case cheaply, and the
 * UniqueConstraintError catch handles the race between two concurrent calls
 * both passing that check (e.g. two poller instances).
 *
 * Exported for testing only — every real caller goes through processEvent.
 */
export async function enqueueWebhookFanout(event: OutboxEvent, payload: Record<string, unknown>) {
  try {
    const existing = await OutboxEvent.findOne({
      where: { sourceEventId: event.id, channel: "WEBHOOK" },
      attributes: ["id"],
    });
    if (existing) {
      logger.debug(
        { sourceEventId: event.id, fanoutEventId: existing.id },
        "[outbox] webhook fan-out already enqueued for this event, skipping"
      );
      return;
    }

    let tenantId = payload.tenantId as string | undefined;
    if (!tenantId && event.documentId) {
      // Legacy fallback only: every current producer of a WEBHOOK_EVENT_TYPES
      // row stamps payload.tenantId at enqueue time. This bare read works under
      // the superuser dev role but CANNOT work under edams_app (documents'
      // strict RLS policy has no unset-GUC arm and there is no tenant to scope
      // by yet — that's the chicken-and-egg this fallback embodies), in which
      // case tenant-less legacy rows fall through to the warn+skip below.
      const doc = await Document.findByPk(event.documentId, { attributes: ["tenantId"] });
      tenantId = doc?.tenantId;
    }
    if (!tenantId) {
      logger.warn(
        { eventId: event.id, type: event.type },
        "[outbox] cannot fan out webhook — no resolvable tenantId"
      );
      return;
    }

    try {
      await OutboxEvent.create({
        documentId: event.documentId,
        type: event.type,
        channel: "WEBHOOK",
        sourceEventId: event.id,
        payload: JSON.stringify({ ...payload, tenantId })
      });
      logger.debug({ sourceEventId: event.id, type: event.type, tenantId }, "[outbox] webhook fan-out enqueued");
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        // Lost a race against a concurrent enqueueWebhookFanout call for the
        // same source event — the unique index already guarantees exactly
        // one fan-out row exists, so this is a benign no-op, not an error.
        logger.debug(
          { sourceEventId: event.id },
          "[outbox] webhook fan-out race lost — another insert already succeeded"
        );
        return;
      }
      throw err;
    }
  } catch (err) {
    logger.error({ error: err, eventId: event.id }, "[outbox] failed to enqueue webhook fan-out");
  }
}

// Exported for testing (same rationale as enqueueWebhookFanout above): lets
// the WEBSOCKET routing branch be exercised directly instead of through the
// full claim-query/transaction pipeline processOutbox drives it from.
export async function processEvent(event: OutboxEvent) {
  try {
    // Status is already PROCESSING and attempts already incremented by the atomic claim in processOutbox
    const payload = JSON.parse(event.payload);
    const correlationId: string | undefined = payload.correlationId;

    // Fan domain events out to external webhook subscribers via a dedicated,
    // independently-retried WEBHOOK row. Never done for WEBHOOK rows
    // themselves, to avoid recursion / duplicates.
    //
    // FIX: this used to also require `event.attempts === 1` as a "first
    // processing attempt only" guard. attempts is incremented at CLAIM time
    // in processOutbox, before this code runs — so a crash/restart between
    // claim and this line left attempts at 1 with fan-out never having
    // happened; the row is later reclaimed with attempts now 2+, and the
    // `=== 1` check then permanently (silently) skipped fan-out forever.
    // enqueueWebhookFanout is now idempotent by construction (source_event_id
    // + a partial unique index — see its docstring), so it's always safe —
    // and necessary — to call regardless of attempts: a reclaimed event that
    // never actually fanned out gets a real chance to, and one that already
    // did is a cheap no-op.
    if (event.channel !== "WEBHOOK" && WEBHOOK_EVENT_TYPES.has(event.type)) {
      await enqueueWebhookFanout(event, payload);
    }

    switch (event.channel) {
      case "WEBSOCKET": {
        if (await hasDispatched("WEBSOCKET", event.id)) {
          logger.warn({ eventId: event.id }, "[outbox] WEBSOCKET event already dispatched, skipping duplicate");
          break;
        }
        let dispatched = false;
        // FIX: an approval/audit step's assignee is not guaranteed to be a
        // member of the item's department (that's the whole point of the
        // named-person / cross-department assignee picker) — routing purely
        // by departmentId silently missed the one person who most needs the
        // live update. recipientUserIds names specific users to also reach,
        // on top of (not instead of) the department room.
        const recipientRooms = Array.isArray(payload.recipientUserIds)
          ? (payload.recipientUserIds as string[]).map((id) => `user_${id}`)
          : [];
        if (payload.room || payload.departmentId || recipientRooms.length > 0) {
          const rooms = [
            ...(payload.room ? [payload.room as string] : []),
            ...(payload.departmentId ? [`department_${payload.departmentId}`] : []),
            ...recipientRooms,
          ];
          emitDomainEvent(rooms, event.type, payload);
          dispatched = true;
        } else if (payload.tenantId) {
          // FIX: the admin room is now tenant-scoped (see socket.ts) — route
          // there using the event's own tenantId instead of a bare "admin"
          // room nothing joins anymore.
          emitDomainEvent(`admin_${payload.tenantId}`, event.type, payload);
          dispatched = true;
        } else {
          logger.warn(
            { eventId: event.id, type: event.type },
            "[outbox] WEBSOCKET event has no room/departmentId/tenantId — nowhere to route it",
          );
        }
        // Only claim the dedupe guard after a real emit, so nothing is ever
        // suppressed on a redelivery that never actually reached a client.
        if (dispatched) await markDispatched("WEBSOCKET", event.id);
        break;
      }
      case "WEBHOOK":
        await deliverWebhookEvent(event);
        break;
      case "EMAIL": {
        if (await hasDispatched("EMAIL", event.id)) {
          logger.warn({ eventId: event.id }, "[outbox] EMAIL event already dispatched, skipping duplicate send");
          break;
        }
        // Recipient/attachment resolution reads RLS-protected tables
        // (documents, workflow_tasks, dept_keys via fetchAndDecrypt). When the
        // payload names its tenant — every current EMAIL producer stamps it —
        // run those reads under that tenant's GUC so they still resolve under
        // the non-superuser role; tenant-less legacy rows keep the bare reads,
        // which only the users-table escape valve can satisfy.
        const inTenantCtx = <T>(fn: () => Promise<T>): Promise<T> =>
          typeof payload.tenantId === "string" && payload.tenantId
            ? withWorkerTenantContext(payload.tenantId, fn)
            : fn();
        const resolved = await inTenantCtx(() => resolveEmailRecipient(event.type, payload));
        const recipients = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
        if (recipients.length === 0) {
          logger.warn(
            { eventId: event.id, type: event.type },
            "[outbox] EMAIL event — no resolvable recipient, skipping"
          );
          break;
        }
        // L3: honor user opt-outs for work-reminder emails (never for
        // compliance or external-recipient emails — see PREF_SUPPRESSIBLE).
        const finalRecipients = await filterByEmailPrefs(event.type, recipients);
        if (finalRecipients.length === 0) {
          logger.info(
            { eventId: event.id, type: event.type },
            "[outbox] EMAIL event — every recipient opted out, skipping"
          );
          break;
        }
        const { subject, text, html } = renderEmail(event.type, payload);
        const attachments = await inTenantCtx(() => resolveEmailAttachment(payload));
        await sendEmail({ to: finalRecipients, subject, text, html, attachments });
        // Claim the dedupe guard only after the send actually succeeded. If
        // sendEmail threw, we fall through to the catch and the row is retried
        // with the guard still unset — preserving at-least-once delivery.
        await markDispatched("EMAIL", event.id);
        break;
      }
      case "OCR":
        if (ocrQueue) await ocrQueue.add(event.type, payload, { jobId: event.id });
        else logger.warn({ correlationId }, "OCR queue not available, skipping outbox event");
        break;
      case "SEARCH_INDEX":
        if (searchQueue) await searchQueue.add(event.type, payload, { jobId: event.id });
        else logger.warn({ correlationId }, "Search index queue not available, skipping outbox event");
        break;
      default:
        logger.warn({ channel: event.channel }, "unknown outbox channel");
    }

    logger.debug({ eventId: event.id, type: event.channel, correlationId }, "[outbox] event processed");
    outboxEventsProcessed.inc({ channel: event.channel, outcome: "processed" });
    // E24: a delivered e-signing invite must not keep the signer's raw link at rest.
    const redactedPayload = redactOutboxPayload(event.type, event.payload);
    await event.update({ status: "PROCESSED", processedAt: new Date(), ...(redactedPayload ? { payload: redactedPayload } : {}) });
  } catch (error) {
    const payload = JSON.parse(event.payload).correlationId;
    logger.error({ error, eventId: event.id, correlationId: payload }, "failed to process outbox event");
    // Move to DEAD_LETTER once maxAttempts is exhausted so the poller never
    // picks it up again; otherwise FAILED with an exponential backoff window
    // (30s, 2m, 8m…) so the claim query re-selects it once process_after passes.
    const exhausted = event.attempts >= event.maxAttempts;
    outboxEventsProcessed.inc({ channel: event.channel, outcome: exhausted ? "dead_letter" : "failed" });
    const backoffMs = Math.min(30_000 * Math.pow(4, Math.max(0, event.attempts - 1)), 3_600_000);
    await event.update({
      status: exhausted ? "DEAD_LETTER" : "FAILED",
      processAfter: exhausted ? event.processAfter : new Date(Date.now() + backoffMs),
      errorMsg: error instanceof Error ? error.message : String(error)
    });
    // FIX: a permanently-failed event used to just stop, silently, with no
    // signal beyond a normal-looking error log line indistinguishable from
    // a retryable failure. Log at ERROR with an explicit, greppable/
    // alertable marker once it's actually terminal.
    if (exhausted) {
      logger.error(
        { eventId: event.id, type: event.type, channel: event.channel, attempts: event.attempts },
        "[outbox] DEAD_LETTER — event permanently failed after exhausting all retries",
      );
      // L5: a log line is not an alert. Surface the dead-letter to system
      // admins as an in-app notification pointing at the existing
      // /operations/outbox retry surface. Dynamic import breaks the module
      // cycle (notifications.service imports enqueueWebsocketEvent from this
      // file); best-effort — a notification failure must not mask the
      // original error handling.
      try {
        const { fanOut } = await import("../../modules/notifications/notifications.service.js");
        const payloadTenant = (() => {
          try { return JSON.parse(event.payload)?.tenantId as string | undefined; } catch { return undefined; }
        })();
        await fanOut({
          type: "OUTBOX_DEAD_LETTER",
          tenantId: payloadTenant ?? "system",
          severity: "CRITICAL",
          payload: { eventId: event.id, eventType: event.type, channel: event.channel, error: event.errorMsg },
        });
      } catch (notifyErr) {
        logger.error({ notifyErr, eventId: event.id }, "[outbox] failed to notify admins of DEAD_LETTER event");
      }
      // The fanOut above is an IN-APP notification bell entry — someone has to
      // be looking at DMS to ever see it. Route the same fault through the
      // Slack/email admin alerts (infrastructure/alerting/adminAlerts.ts) so
      // a permanently-failed background job (a webhook, an email, an OCR/
      // search-index update) gets the same real-time treatment as a live
      // request 500, not just a bell icon nobody's watching.
      recordSystemError({
        method: "OUTBOX",
        route: `${event.channel}:${event.type}`,
        errorName: "OutboxDeadLetter",
        errorMessage: event.errorMsg ?? "Event permanently failed after exhausting all retries",
        requestId: event.id,
      });
    }
  }
}

let interval: NodeJS.Timeout | null = null;

export function startOutboxPolling() {
  if (interval) return;
  interval = setInterval(processOutbox, config.OUTBOX_POLL_INTERVAL_MS);
  logger.info({ intervalMs: config.OUTBOX_POLL_INTERVAL_MS }, "outbox polling started");
}

export function stopOutboxPolling() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

async function resolveEmailRecipient(
  type: string,
  payload: Record<string, unknown>
): Promise<string | string[] | null> {
  // SYSTEM.ALERT: recipients were resolved (tenant-scoped SYSTEM_ADMINs) by
  // fanOut at enqueue time and travel in the payload as user ids.
  if (type === "SYSTEM.ALERT") {
    const ids = (payload.recipientUserIds as string[] | undefined) ?? [];
    if (ids.length === 0) return null;
    const users = await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["email"] });
    return users.map((u) => u.email);
  }

  if (
    type === "RETENTION.DISPOSAL_WARNING_90" ||
    type === "RETENTION.DISPOSAL_WARNING_30" ||
    type === "RETENTION.DISPOSAL_PENDING" ||
    type === "RETENTION.DISPOSAL_EXECUTED" ||
    type === "LEGALHOLD.DOCUMENT_HELD" ||
    type === "LEGALHOLD.DOCUMENT_RELEASED"
  ) {
    const doc = await Document.findByPk(payload.documentId as string, {
      attributes: ["ownerId"],
    });
    if (!doc) return null;
    const user = await User.findByPk(doc.ownerId, { attributes: ["email"] });
    return user?.email ?? null;
  }

  if (type === "WORKFLOW.SLA_BREACH") {
    const task = await WorkflowTask.findByPk(payload.taskId as string, {
      attributes: ["assignedToUserId", "delegatedToUserId", "assignedToRole", "tenantId"],
    });
    if (!task) return null;
    const userId = task.delegatedToUserId ?? task.assignedToUserId;
    if (userId) {
      const user = await User.findByPk(userId, { attributes: ["email"] });
      return user?.email ?? null;
    }
    // Role-assigned task (no specific user yet): notify a holder of the role.
    if (task.assignedToRole) return resolveRoleRecipients(task.assignedToRole, task.tenantId);
    return null;
  }

  // E-signing: recipient is an external signer with no DMS User row — the
  // email address travels in the payload itself, unlike every other case here.
  if (type === "ESIGNING.RECIPIENT_INVITED") {
    return (payload.email as string) ?? null;
  }

  // Letters: a step became PENDING for a named user or a role.
  if (type === "LETTER.STEP_PENDING") {
    if (payload.assignedUserId) {
      const user = await User.findByPk(payload.assignedUserId as string, { attributes: ["email"] });
      return user?.email ?? null;
    }
    if (payload.assignedRole && payload.tenantId) {
      return resolveRoleRecipients(payload.assignedRole as string, payload.tenantId as string);
    }
    return null;
  }

  // Executive correspondence oversight — one outbox row per recipient,
  // created directly with the target userId (see letters.service.ts's
  // notifyExecutivesOfLetter), not a role lookup at send time.
  if (type === "LETTER.EXECUTIVE_NOTICE") {
    if (!payload.recipientUserId) return null;
    const user = await User.findByPk(payload.recipientUserId as string, { attributes: ["email"] });
    return user?.email ?? null;
  }

  // Engine approval-step SLA breach (H6): a named assignee, or a role.
  if (type === "APPROVAL.SLA_BREACH") {
    if (payload.assignedUserId) {
      const user = await User.findByPk(payload.assignedUserId as string, { attributes: ["email"] });
      return user?.email ?? null;
    }
    if (payload.assignedRole && payload.tenantId) {
      return resolveRoleRecipients(payload.assignedRole as string, payload.tenantId as string);
    }
    return null;
  }

  // Generic: events that carry their recipient in the payload directly —
  // used by trash/purge notices (M11), whose document row may already be
  // deleted by the time this dispatch runs.
  if (payload.recipientUserId) {
    const user = await User.findByPk(payload.recipientUserId as string, { attributes: ["email"] });
    return user?.email ?? null;
  }

  return null;
}

/** Attaches the referenced document's actual bytes to the email, when the
 *  payload names one (`attachDocumentId`) — e.g. the letter file on a
 *  correspondence notice. Fetched at send time rather than carried in the
 *  outbox row itself, since outbox payloads are JSON and this can be
 *  multi-megabyte binary content. */
async function resolveEmailAttachment(
  payload: Record<string, unknown>,
): Promise<{ filename: string; content: Buffer; contentType?: string }[] | undefined> {
  const documentId = payload.attachDocumentId as string | undefined;
  if (!documentId) return undefined;
  const version = await DocumentVersion.findOne({
    where: { documentId }, order: [["createdAt", "DESC"]],
  });
  if (!version) return undefined;
  try {
    const buffer = await fetchAndDecrypt(version.storageKey, version.id);
    return [{ filename: version.originalFilename, content: buffer, contentType: version.mimeType }];
  } catch (error) {
    logger.warn({ error, documentId }, "[outbox] failed to fetch document for email attachment, sending without it");
    return undefined;
  }
}

/** L6: every active holder of `roleName` in `tenantId`. This used to
 *  `LIMIT 1` on the oldest account — a role-assigned task's email reached only
 *  one arbitrary holder, and if that person was on leave, nobody else ever
 *  heard about it. Any holder can act, so all of them are notified. */
async function resolveRoleRecipients(roleName: string, tenantId: string): Promise<string[]> {
  const rows = await sequelize.query<{ email: string }>(
    `SELECT DISTINCT u.email
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       JOIN user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = :tenantId
      WHERE r.name = :roleName AND u.is_active = true AND ${notPlatformAdminSql("u.id")}`,
    { replacements: { roleName, tenantId }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => r.email);
}

/** L3: outbox event types a user may opt out of, mapped to the preference key
 *  that suppresses them. Deliberately NOT listed: retention/trash/purge
 *  notices (compliance record), e-sign invites and letter dispatches
 *  (external recipients with no account), executive notices (which have
 *  their own dedicated opt-out), and — per S19 audit — SLA-BREACH escalations
 *  (WORKFLOW/APPROVAL.SLA_BREACH): these are compliance escalations aimed at the
 *  very person responsible for the overdue item, who must not be able to silence
 *  them. Only routine "your step is pending" reminders remain suppressible. */
const PREF_SUPPRESSIBLE: Record<string, string> = {
  "LETTER.STEP_PENDING": "emailOnWorkflow",
  // notifications.service.ts's fanOut() — approval/audit-stage decisions
  // (documents and forms), e-signing assignment/decline/completion, and
  // letter approved/returned/cancelled/registered all ride this one outbox
  // event type (see EMAIL_ALSO_ON_FANOUT), so they share one opt-out lever
  // rather than one preference key each. SLA-breach escalations are a
  // different type (APPROVAL.SLA_BREACH/WORKFLOW.SLA_BREACH) and stay out of
  // this map entirely, same as before.
  "NOTIFICATION.FANOUT": "emailOnWorkflow",
  // Informational notice to the document owner — the hold itself is enforced
  // server-side either way, so opting out loses nothing compliance-wise.
  "LEGALHOLD.DOCUMENT_HELD": "emailOnLegalHold",
  "LEGALHOLD.DOCUMENT_RELEASED": "emailOnLegalHold",
  // Operator alert emails; the in-app CRITICAL notification is not suppressible.
  "SYSTEM.ALERT": "emailOnSystem",
};

async function filterByEmailPrefs(type: string, emails: string[]): Promise<string[]> {
  const prefKey = PREF_SUPPRESSIBLE[type];
  if (!prefKey || emails.length === 0) return emails;
  const users = await User.findAll({
    where: { email: { [Op.in]: emails } },
    attributes: ["email", "notificationPrefs"],
  });
  const optedOut = new Set(
    users
      .filter((u) => (u.notificationPrefs as Record<string, boolean> | null)?.[prefKey] === false)
      .map((u) => u.email),
  );
  return emails.filter((e) => !optedOut.has(e));
}
