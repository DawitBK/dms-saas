/**
 * Outbox rows abandoned in PROCESSING get a terminal state.
 *
 * THE LEAK THIS PINS
 *
 * The claim query filters on `attempts < max_attempts` at the TOP level, so that
 * condition applies to its PROCESSING reclaim branch too. A row whose worker
 * died on its LAST attempt is therefore invisible to it forever: never
 * reclaimed (no attempts left), never dead-lettered (only the failure handler
 * does that, and that worker is gone). It sits in PROCESSING permanently — 56
 * of them on the dev database when this was found.
 *
 * PROCESSING means "in flight". Notifications, emails and every realtime event
 * ride this outbox, so an operator looking at the queue could not tell a
 * genuinely busy row from one abandoned weeks earlier.
 *
 * WHY THIS IS A LIVE SCRIPT AND NOT A UNIT TEST
 *
 * The first implementation of the sweep expressed its predicate as
 * `attempts: { [Op.gte]: sequelize.col("max_attempts") }`. That type-checks,
 * reads correctly, and matched NOTHING — verified against a database holding 5
 * qualifying rows. A mocked test would have asserted the call was made and
 * passed. Only running it against Postgres shows the predicate is real.
 *
 * Needs a database (no HTTP server required).
 * Run: npx tsx test-scripts/verify-outbox-abandoned-sweep.ts
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { connectDB, initModels, sequelize, OutboxEvent } from '../src/infrastructure/database/index.js';
import { retireAbandonedProcessingEvents } from '../src/infrastructure/queue/outbox.js';
import { QueryTypes } from 'sequelize';

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

/** Plant a row directly, so its exact state is known rather than provoked. */
async function plant(opts: {
  status: string;
  attempts: number;
  maxAttempts: number;
  startedMinutesAgo: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  await sequelize.query(
    `INSERT INTO outbox_events
       (id, document_id, type, channel, payload, status, attempts, max_attempts,
        process_after, created_at, processing_started_at)
     VALUES
       (:id, NULL, 'VERIFY.SWEEP', 'WEBSOCKET', :payload, :status, :attempts, :maxAttempts,
        NOW(), NOW(), NOW() - (:mins || ' minutes')::interval)`,
    {
      replacements: {
        id,
        payload: JSON.stringify({ verifier: 'outbox-abandoned-sweep' }),
        status: opts.status,
        attempts: opts.attempts,
        maxAttempts: opts.maxAttempts,
        mins: String(opts.startedMinutesAgo),
      },
      type: QueryTypes.INSERT,
    },
  );
  return id;
}

async function statusOf(id: string): Promise<{ status: string; attempts: number; errorMsg: string | null } | null> {
  const rows = await sequelize.query<{ status: string; attempts: number; error_msg: string | null }>(
    `SELECT status, attempts, error_msg FROM outbox_events WHERE id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT },
  );
  const row = rows[0];
  return row ? { status: row.status, attempts: row.attempts, errorMsg: row.error_msg } : null;
}

async function main() {
  console.log('\n═══ Outbox: abandoned PROCESSING sweep ═══\n');
  await initModels();
  await connectDB();

  const planted: string[] = [];
  try {
    // The leak itself: stuck, and out of retries.
    const abandoned = await plant({ status: 'PROCESSING', attempts: 3, maxAttempts: 3, startedMinutesAgo: 30 });
    // Stuck but still has a retry left — the CLAIM query owns this one, and the
    // sweep must keep its hands off or it steals a legitimate retry.
    const reclaimable = await plant({ status: 'PROCESSING', attempts: 1, maxAttempts: 3, startedMinutesAgo: 30 });
    // Out of retries but only just started — genuinely in flight right now.
    const inFlight = await plant({ status: 'PROCESSING', attempts: 3, maxAttempts: 3, startedMinutesAgo: 0 });
    // A normal queued event, which nothing here should touch.
    const pending = await plant({ status: 'PENDING', attempts: 0, maxAttempts: 3, startedMinutesAgo: 0 });
    planted.push(abandoned, reclaimable, inFlight, pending);

    check('four probe events are planted', (await statusOf(abandoned))?.status === 'PROCESSING');

    // Prove the leak exists as described: the claim query cannot see the
    // abandoned row, because its top-level guard excludes it.
    const claimable = await sequelize.query<{ id: string }>(
      `SELECT id FROM outbox_events
       WHERE id = :id
         AND attempts < max_attempts
         AND (
           (status IN ('PENDING','FAILED') AND process_after <= NOW())
           OR (status = 'PROCESSING' AND processing_started_at <= NOW() - INTERVAL '5 minutes')
         )`,
      { replacements: { id: abandoned }, type: QueryTypes.SELECT },
    );
    check(
      'the claim query genuinely cannot reclaim the abandoned row (this is the leak)',
      claimable.length === 0,
    );

    await retireAbandonedProcessingEvents();

    const after = await statusOf(abandoned);
    check('the abandoned row is retired to DEAD_LETTER', after?.status === 'DEAD_LETTER', after);
    check(
      'it is NOT handed a free retry — a poison event must not cycle forever',
      after?.attempts === 3,
      after?.attempts,
    );
    check(
      'it records why it was retired, not a generic failure',
      Boolean(after?.errorMsg && /abandoned/i.test(after.errorMsg)),
      after?.errorMsg,
    );

    const stillReclaimable = await statusOf(reclaimable);
    check(
      'a stuck row that still has retries is left for the claim query',
      stillReclaimable?.status === 'PROCESSING' && stillReclaimable.attempts === 1,
      stillReclaimable,
    );

    const stillInFlight = await statusOf(inFlight);
    check(
      'a row that only just started is left alone, however many attempts it has spent',
      stillInFlight?.status === 'PROCESSING',
      stillInFlight,
    );

    const stillPending = await statusOf(pending);
    check('a normal PENDING event is untouched', stillPending?.status === 'PENDING', stillPending);

    // Idempotent: a second sweep must be a no-op, not a source of churn.
    await retireAbandonedProcessingEvents();
    const afterSecond = await statusOf(abandoned);
    check('running the sweep again changes nothing', afterSecond?.status === 'DEAD_LETTER', afterSecond);
  } finally {
    if (planted.length) {
      await OutboxEvent.destroy({ where: { id: planted }, force: true });
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err);
  process.exit(1);
});
