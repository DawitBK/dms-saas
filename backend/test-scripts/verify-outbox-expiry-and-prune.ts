/**
 * Stale outbox events expire, durable work never does, and history is pruned.
 *
 * WHAT THIS PROTECTS
 *
 * The outbox had no notion of an event going stale, so a row queued two months
 * ago was delivered the instant a worker could reach its transport again. That
 * is correct for durable work and dangerous for a notification.
 *
 * It fired for real on 2026-09-03: pointing dev SMTP at the production Gmail
 * relay to test the mail path caused the poller to start relaying months-old
 * alerts in bulk. 95 went out and 133 authenticated logins in a few minutes was
 * enough for Gmail to answer `454-4.7.0 Too many login attempts` and block the
 * account all four Example Corp systems send through — an outbound-mail outage
 * for the whole platform, caused by notifications nobody wanted any more.
 *
 * THE PART THAT MUST NOT REGRESS
 *
 * OCR and SEARCH_INDEX events are durable work orders, not notifications.
 * Expiring one leaves a document permanently un-OCR'd or unsearchable, with
 * nothing anywhere to say why. Any future change that expires "old outbox
 * events" generically breaks this, and no user-visible symptom appears for
 * weeks. Half the checks below exist for that one line.
 *
 * WHY A LIVE SCRIPT
 *
 * Both functions are single SQL predicates over NOW() and an interval, and this
 * file has already been burned twice by predicates that type-check, read
 * correctly and match nothing — `attempts >= sequelize.col("max_attempts")`,
 * and counting a bare Postgres DELETE's first return element. A mocked test
 * asserts the call happened. Only Postgres says whether it did anything.
 *
 * Needs a database (no HTTP server required).
 * Run: npx tsx test-scripts/verify-outbox-expiry-and-prune.ts
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize, OutboxEvent } from '../src/infrastructure/database/index.js';
import { expireStaleEvents, pruneOutboxHistory } from '../src/infrastructure/queue/outbox.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`, details ?? '');
  }
}

/** Plant a row directly, so its exact age and state are known rather than provoked. */
async function plant(opts: { channel: string; status: string; hoursAgo: number }): Promise<string> {
  const id = crypto.randomUUID();
  await sequelize.query(
    `INSERT INTO outbox_events
       (id, document_id, type, channel, payload, status, attempts, max_attempts,
        process_after, created_at, processing_started_at)
     VALUES
       (:id, NULL, 'VERIFY.EXPIRY', :channel, :payload, :status, 0, 3,
        NOW() - (:hours || ' hours')::interval,
        NOW() - (:hours || ' hours')::interval,
        NULL)`,
    {
      replacements: {
        id,
        channel: opts.channel,
        status: opts.status,
        hours: String(opts.hoursAgo),
        payload: JSON.stringify({ verifier: 'outbox-expiry-and-prune' }),
      },
      type: QueryTypes.INSERT,
    },
  );
  return id;
}

async function statusOf(id: string): Promise<{ status: string; errorMsg: string | null } | null> {
  const rows = await sequelize.query<{ status: string; error_msg: string | null }>(
    `SELECT status, error_msg FROM outbox_events WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT },
  );
  return rows[0] ? { status: rows[0].status, errorMsg: rows[0].error_msg } : null;
}

async function exists(id: string): Promise<boolean> {
  const rows = await sequelize.query<{ n: string }>(
    `SELECT count(*) AS n FROM outbox_events WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT },
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function main() {
  console.log('\n═══ Outbox: stale-event expiry and history pruning ═══\n');
  await initModels();
  await connectDB();

  const planted: string[] = [];
  try {
    // ── Expiry ────────────────────────────────────────────────────────────
    const staleSocket = await plant({ channel: 'WEBSOCKET', status: 'PENDING', hoursAgo: 5 });
    const freshSocket = await plant({ channel: 'WEBSOCKET', status: 'PENDING', hoursAgo: 0 });
    const staleEmail = await plant({ channel: 'EMAIL', status: 'PENDING', hoursAgo: 200 });
    const staleEmailFailed = await plant({ channel: 'EMAIL', status: 'FAILED', hoursAgo: 200 });
    const freshEmail = await plant({ channel: 'EMAIL', status: 'PENDING', hoursAgo: 2 });
    const staleWebhook = await plant({ channel: 'WEBHOOK', status: 'PENDING', hoursAgo: 200 });
    // The two that must survive at any age.
    const ancientOcr = await plant({ channel: 'OCR', status: 'PENDING', hoursAgo: 5000 });
    const ancientIndex = await plant({ channel: 'SEARCH_INDEX', status: 'PENDING', hoursAgo: 5000 });
    // Already delivered — expiry must not rewrite terminal states.
    const processedEmail = await plant({ channel: 'EMAIL', status: 'PROCESSED', hoursAgo: 200 });
    planted.push(
      staleSocket, freshSocket, staleEmail, staleEmailFailed, freshEmail,
      staleWebhook, ancientOcr, ancientIndex, processedEmail,
    );

    await expireStaleEvents();

    const socketAfter = await statusOf(staleSocket);
    check('a WEBSOCKET event hours past its moment is expired', socketAfter?.status === 'DEAD_LETTER', socketAfter);
    check(
      'it says it expired, not that delivery failed',
      Boolean(socketAfter?.errorMsg && /expired/i.test(socketAfter.errorMsg)),
      socketAfter?.errorMsg,
    );
    check('a WEBSOCKET event queued just now is left alone', (await statusOf(freshSocket))?.status === 'PENDING');

    check('a 200h-old EMAIL is expired', (await statusOf(staleEmail))?.status === 'DEAD_LETTER');
    check('a FAILED EMAIL past the window is expired too, not left retrying', (await statusOf(staleEmailFailed))?.status === 'DEAD_LETTER');
    check(
      'an EMAIL inside the window survives — this bounds a flood, it does not suppress mail',
      (await statusOf(freshEmail))?.status === 'PENDING',
    );
    check('a 200h-old WEBHOOK is expired', (await statusOf(staleWebhook))?.status === 'DEAD_LETTER');

    // The ones that matter most.
    check(
      'an OCR job is NEVER expired, however old — it is durable work, not a notification',
      (await statusOf(ancientOcr))?.status === 'PENDING',
      await statusOf(ancientOcr),
    );
    check(
      'a SEARCH_INDEX job is NEVER expired — expiring one leaves a document silently unsearchable',
      (await statusOf(ancientIndex))?.status === 'PENDING',
      await statusOf(ancientIndex),
    );
    check('an already-PROCESSED row is not rewritten', (await statusOf(processedEmail))?.status === 'PROCESSED');

    // Idempotent: a second pass must be a no-op, not churn.
    await expireStaleEvents();
    check('running expiry again changes nothing', (await statusOf(freshEmail))?.status === 'PENDING');

    // ── Pruning ───────────────────────────────────────────────────────────
    //
    // Planted at ages either side of both retention windows (7 days for
    // delivered history, 90 for dead letters), because a prune that deletes
    // too much is worse than one that deletes nothing.
    const oldProcessed = await plant({ channel: 'WEBSOCKET', status: 'PROCESSED', hoursAgo: 24 * 30 });
    const recentProcessed = await plant({ channel: 'WEBSOCKET', status: 'PROCESSED', hoursAgo: 24 * 2 });
    const oldDeadLetter = await plant({ channel: 'EMAIL', status: 'DEAD_LETTER', hoursAgo: 24 * 200 });
    const recentDeadLetter = await plant({ channel: 'EMAIL', status: 'DEAD_LETTER', hoursAgo: 24 * 10 });
    const oldPending = await plant({ channel: 'OCR', status: 'PENDING', hoursAgo: 24 * 200 });
    planted.push(oldProcessed, recentProcessed, oldDeadLetter, recentDeadLetter, oldPending);

    await pruneOutboxHistory();

    check('delivered history past 7 days is deleted', !(await exists(oldProcessed)));
    check('recently delivered history is kept', await exists(recentProcessed));
    check('a dead letter past 90 days is deleted', !(await exists(oldDeadLetter)));
    check(
      'a recent dead letter is kept — it is the operator evidence /operations/outbox reads',
      await exists(recentDeadLetter),
    );
    check(
      'an undelivered OCR job is never pruned, however old — pruning is for history only',
      await exists(oldPending),
    );
  } finally {
    if (planted.length) await OutboxEvent.destroy({ where: { id: planted }, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err);
  process.exit(1);
});
