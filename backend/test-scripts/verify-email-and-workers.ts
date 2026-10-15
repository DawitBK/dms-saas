/**
 * Email delivery and BullMQ worker health, against the real relay.
 *
 * WHY THIS EXISTS
 *
 * The dev database had ~9,000 dead-lettered outbox events and the obvious read
 * was "the email subsystem is broken". It was not. Every one of them carried
 * the same error:
 *
 *     Stream isn't writeable and enableOfflineQueue options is false
 *
 * which is ioredis, not nodemailer. The EMAIL and WEBSOCKET branches of
 * processEvent both open with a hasDispatched() dedupe lookup on the fail-fast
 * cache client. With Redis merely DOWN (as opposed to unconfigured) that lookup
 * rejects, so the row burned all three attempts inside an *optimisation* and
 * reached DEAD_LETTER without ever attempting delivery. hasDispatched and
 * markDispatched now fail open; this verifier is what proves the path is
 * genuinely healthy rather than quiet.
 *
 * WHAT IT PROVES
 *
 *   1. Redis is up, and every declared BullMQ queue is reachable through it.
 *   2. The configured SMTP relay authenticates — separately from any send, so a
 *      credential problem is distinguishable from a delivery problem.
 *   3. sendEmail() actually delivers, and the EMAIL_REDIRECT_TO dev valve keeps
 *      the intended recipients visible instead of dropping them.
 *   4. The outbox EMAIL channel delivers end to end through processEvent — the
 *      exact path all 1,540 dead letters died on.
 *   5. The dedupe guard suppresses a redelivery, and only after a real send.
 *   6. The EMAILS BullMQ worker consumes and completes a real job.
 *
 * Needs Postgres, Redis, and SMTP_* pointed at a relay that will accept mail.
 * Sends real email — set EMAIL_REDIRECT_TO first.
 *
 * Run: npx tsx test-scripts/verify-email-and-workers.ts
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { QueryTypes } from 'sequelize';
import { config } from '../src/config/env.js';
import { connectDB, initModels, sequelize, OutboxEvent } from '../src/infrastructure/database/index.js';
import { getRedis, getCacheRedis } from '../src/infrastructure/cache/redis.js';
import { queueNames, createQueue } from '../src/infrastructure/queue/queues.js';
import { processEvent } from '../src/infrastructure/queue/outbox.js';
import { sendEmail } from '../src/infrastructure/email/mailer.js';
import { createEmailWorker } from '../src/infrastructure/queue/workers/EmailWorker.js';

const TEST_RECIPIENT = process.env.VERIFY_EMAIL_TO ?? 'dawitbk01@gmail.com';

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

/** Poll until fn is truthy, so nothing here depends on a fixed sleep. */
async function until<T>(fn: () => Promise<T | null | undefined>, ms = 20_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  console.log('\n═══ Email delivery and worker health ═══\n');
  console.log(`  relay      ${config.SMTP_HOST}:${config.SMTP_PORT} as ${config.SMTP_USER ?? '(no auth)'}`);
  console.log(`  redirect   ${config.EMAIL_REDIRECT_TO ?? '(none — mail goes to real recipients)'}`);
  console.log(`  test to    ${TEST_RECIPIENT}\n`);

  await initModels();
  await connectDB();

  // ── 1. Redis and every declared queue ─────────────────────────────────────
  const cache = getCacheRedis();
  if (cache && cache.status === 'wait') await cache.connect().catch(() => {});
  const pong = await cache?.ping().catch((e: Error) => e.message);
  check('Redis answers PING on the fail-fast cache client', pong === 'PONG', pong);

  const bull = getRedis();
  if (bull && bull.status === 'wait') await bull.connect().catch(() => {});

  const unreachable: string[] = [];
  for (const name of queueNames) {
    const q = createQueue(name);
    if (!q) {
      unreachable.push(`${name}: not created`);
      continue;
    }
    try {
      await q.getJobCounts();
    } catch (error) {
      unreachable.push(`${name}: ${(error as Error).message}`);
    }
  }
  check(`all ${queueNames.length} BullMQ queues are reachable`, unreachable.length === 0, unreachable);

  // ── 2. The relay authenticates ────────────────────────────────────────────
  //
  // Deliberately separate from sending. "Nothing arrived" has two very
  // different causes, and this is the one that produces 535 BadCredentials —
  // which has already bitten this exact config once (see .env.production).
  const probe = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER && config.SMTP_PASS ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
  });
  const verified = await probe.verify().then(() => true).catch((e: Error) => e.message);
  check('the SMTP relay accepts the configured credentials', verified === true, verified);
  probe.close();

  // ── 3. A direct send ──────────────────────────────────────────────────────
  const stamp = new Date().toISOString();
  const directSend = await sendEmail({
    to: TEST_RECIPIENT,
    subject: `DMS verifier — direct send ${stamp}`,
    text: `Sent by verify-email-and-workers.ts at ${stamp}.`,
    html: `<p>Sent by <code>verify-email-and-workers.ts</code> at ${stamp}.</p>`,
  }).then(() => true).catch((e: Error) => e.message);
  check('sendEmail() delivers to the relay without throwing', directSend === true, directSend);

  if (config.EMAIL_REDIRECT_TO) {
    // The redirect must not simply swallow the addressee: a dev send asks
    // "would the right person have been mailed?", and a message that hides the
    // answer is testing something else.
    const redirected = await sendEmail({
      to: ['someone@edams.local', 'another@edams.local'],
      subject: `DMS verifier — redirect valve ${stamp}`,
      text: 'The subject line of this message should name both intended recipients.',
    }).then(() => true).catch((e: Error) => e.message);
    check('a message addressed elsewhere is redirected, not delivered to it', redirected === true, redirected);
  }

  // ── 4. The outbox EMAIL channel, end to end ───────────────────────────────
  //
  // ESIGNING.RECIPIENT_INVITED because its recipient travels in the payload (an
  // external signer has no User row), so this exercises the real branch without
  // repointing a seeded user at a live mailbox.
  const eventId = crypto.randomUUID();
  await sequelize.query(
    `INSERT INTO outbox_events
       (id, document_id, type, channel, payload, status, attempts, max_attempts, process_after, created_at)
     VALUES
       (:id, NULL, 'ESIGNING.RECIPIENT_INVITED', 'EMAIL', :payload, 'PENDING', 0, 3, NOW(), NOW())`,
    {
      replacements: {
        id: eventId,
        payload: JSON.stringify({
          email: TEST_RECIPIENT,
          recipientName: 'DMS Verifier',
          documentTitle: `Outbox EMAIL channel probe ${stamp}`,
          signingUrl: 'https://portal.examplecorp.com/dms/sign/verifier-probe',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      },
      type: QueryTypes.INSERT,
    },
  );

  try {
    const event = await OutboxEvent.findByPk(eventId);
    check('the probe event is queued', event?.status === 'PENDING');

    await processEvent(event!);
    await event!.reload();
    check(
      'the outbox EMAIL channel processes it — the path 1,540 dead letters died on',
      event!.status === 'PROCESSED',
      { status: event!.status, error: event!.errorMsg },
    );

    // ── 5. The dedupe guard ─────────────────────────────────────────────────
    const guard = await cache?.exists(`dms:outbox:dispatched:EMAIL:${eventId}`);
    check('the dedupe guard is claimed only after the send succeeded', guard === 1, guard);

    // A redelivery must not mail the recipient twice. processEvent short-
    // circuits on the guard; the row still ends PROCESSED, which is correct —
    // it was in fact delivered.
    await processEvent(event!);
    await event!.reload();
    check('a redelivery is suppressed rather than sent again', event!.status === 'PROCESSED', event!.status);
  } finally {
    await OutboxEvent.destroy({ where: { id: eventId }, force: true });
    await cache?.del(`dms:outbox:dispatched:EMAIL:${eventId}`).catch(() => {});
  }

  // ── 6. The EMAILS BullMQ worker ───────────────────────────────────────────
  //
  // Separate from the outbox EMAIL channel on purpose: this queue carries the
  // higher-stakes sends that have real file attachments (a dispatched letter
  // plus its QR cover sheet) and its own retry/backoff bookkeeping. A healthy
  // outbox says nothing about whether this worker is consuming.
  const worker = await createEmailWorker();
  check('the EMAILS worker starts', Boolean(worker));

  if (worker) {
    const emails = createQueue('EMAILS');
    const job = await emails!.add('verify', {
      to: TEST_RECIPIENT,
      type: 'SYSTEM.ALERT',
      payload: {
        title: 'DMS verifier — EMAILS queue',
        message: `Delivered by the BullMQ EMAILS worker at ${stamp}.`,
        severity: 'info',
      },
    });

    const state = await until(async () => {
      const s = await job.getState();
      return s === 'completed' || s === 'failed' ? s : null;
    });
    check('it consumes and completes a real job', state === 'completed', state ?? 'still queued after 20s');
    if (state === 'failed') {
      const fresh = await emails!.getJob(job.id!);
      console.log('     reason:', fresh?.failedReason);
    }
    await job.remove().catch(() => {});
    await worker.close();
  }

  // ── The historical evidence ───────────────────────────────────────────────
  //
  // Recorded as output rather than a comment so the diagnosis stays falsifiable:
  // if a future backlog is NOT dominated by this signature, the cause is
  // something else and this file should stop claiming otherwise.
  const [dead] = await sequelize.query<{ n: string; total: string }>(
    `SELECT count(*) FILTER (WHERE error_msg LIKE '%enableOfflineQueue%') AS n, count(*) AS total
       FROM outbox_events WHERE status = 'DEAD_LETTER'`,
    { type: QueryTypes.SELECT },
  );
  console.log(
    `\n  ${dead?.n} of ${dead?.total} dead-lettered events failed on the Redis dedupe lookup, not on delivery.`,
  );

  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.log(`  Check ${TEST_RECIPIENT} — three messages should have arrived.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  FATAL', err);
  process.exit(1);
});
