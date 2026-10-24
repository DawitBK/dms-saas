/**
 * Load-safety and realtime-transport verification — R-01 and the F-06
 * follow-up of audit 2026-09-03.
 *
 * Three properties that the unit tests cannot prove, because each of them is
 * about the real server, the real database, or the real wire:
 *
 *   1. The per-request transaction really is bounded. `tenantContext` sets
 *      statement_timeout and idle_in_transaction_session_timeout with SET
 *      LOCAL inside the request transaction, in ONE multi-statement query
 *      alongside the tenant GUC. That is a Postgres behaviour (multi-statement
 *      simple queries, per-transaction GUCs, automatic reset at
 *      commit/rollback) — asserting it against a mock would prove nothing.
 *      The reset matters as much as the setting: a timeout that leaked onto a
 *      pooled connection would silently apply to migrations and workers.
 *
 *   2. The Socket.IO endpoint answers where the browser now asks. DMS realtime
 *      was dead in production because the client asked for `/socket.io/` on a
 *      shared origin where that path belongs to GMS, while the rule pointing
 *      at DMS (`/dms/socket.io/` -> 7100) went unused. Apache rewrites the
 *      prefix away before proxying, so the app must answer on the DEFAULT
 *      path — this asserts that, and that WebSocket is an offered upgrade
 *      rather than long-polling being the only thing that works.
 *
 *   3. /operations/health is cheap under repetition. It is the most-polled
 *      route in the product (the dashboard renders a health strip for every
 *      signed-in user), it runs five dependency probes, and it is public. A
 *      burst must collapse onto one probe instead of multiplying.
 *
 * Needs the dev backend running on :7100 for (2) and (3); (1) talks to the
 * database directly.
 *
 * Run: npx tsx test-scripts/verify-load-safety.ts
 */

import 'dotenv/config';
import { QueryTypes } from 'sequelize';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';
import { config } from '../src/config/env.js';

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

const BASE = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:7100';

/** Parse a Postgres interval-ish GUC value ("30s", "2min", "0") into ms. */
function gucToMs(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '0') return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?$/.exec(trimmed);
  if (!match) return NaN;
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'us': return amount / 1000;
    case 'ms':
    case undefined: return amount;
    case 's': return amount * 1000;
    case 'min': return amount * 60_000;
    case 'h': return amount * 3_600_000;
    case 'd': return amount * 86_400_000;
    default: return NaN;
  }
}

async function verifyTransactionBounds() {
  console.log('\n── 1. Per-request transaction bounds (R-01) ─────────────────\n');

  // Exactly the statement tenantContext issues, including the multi-statement
  // shape. If Postgres ever stopped accepting that shape, every authenticated
  // request would fail — so the shape itself is the first assertion.
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query(
      `SET LOCAL app.current_tenant = :tenantId;` +
        ` SET LOCAL statement_timeout = ${config.DB_STATEMENT_TIMEOUT_MS};` +
        ` SET LOCAL idle_in_transaction_session_timeout = ${config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      { transaction, replacements: { tenantId: 'verify-load-safety-tenant' } },
    );
    check('tenantContext\'s multi-statement SET LOCAL is accepted by Postgres', true);

    const [inTx] = (await sequelize.query(
      `SELECT current_setting('app.current_tenant') AS tenant,
              current_setting('statement_timeout') AS stmt,
              current_setting('idle_in_transaction_session_timeout') AS idle`,
      { type: QueryTypes.SELECT, transaction },
    )) as Array<{ tenant: string; stmt: string; idle: string }>;

    check(
      'the tenant GUC is set inside the transaction (RLS depends on it)',
      inTx.tenant === 'verify-load-safety-tenant',
      inTx.tenant,
    );
    check(
      `statement_timeout is applied (${inTx.stmt} = ${config.DB_STATEMENT_TIMEOUT_MS}ms)`,
      gucToMs(inTx.stmt) === config.DB_STATEMENT_TIMEOUT_MS,
      inTx.stmt,
    );
    check(
      `idle_in_transaction_session_timeout is applied (${inTx.idle} = ${config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms)`,
      gucToMs(inTx.idle) === config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      inTx.idle,
    );

    // A statement really is cut off, not just labelled. pg_sleep past the cap
    // must raise 57014 — the SQLSTATE isCapacityError maps to a 503.
    const shortTransactionCheck = await (async () => {
      await sequelize.query(`SET LOCAL statement_timeout = 250`, { transaction });
      try {
        await sequelize.query(`SELECT pg_sleep(2)`, { transaction });
        return { aborted: false, code: null as string | null };
      } catch (error) {
        const code =
          (error as { parent?: { code?: string }; original?: { code?: string }; code?: string })?.parent?.code ??
          (error as { original?: { code?: string } })?.original?.code ??
          (error as { code?: string })?.code ??
          null;
        return { aborted: true, code };
      }
    })();
    check(
      'a statement past the cap is actually aborted',
      shortTransactionCheck.aborted,
      shortTransactionCheck,
    );
    check(
      'the abort carries SQLSTATE 57014, which maps to a 503 rather than a 500',
      shortTransactionCheck.code === '57014',
      shortTransactionCheck.code,
    );
  } finally {
    await transaction.rollback();
  }

  // The reset is the reason these are SET LOCAL rather than connection
  // defaults: the same pool serves the Umzug migration runner and the backfill
  // scripts, where a 30s statement cap would abort a legitimate CREATE INDEX.
  const [afterTx] = (await sequelize.query(
    `SELECT current_setting('statement_timeout') AS stmt,
            current_setting('idle_in_transaction_session_timeout') AS idle`,
    { type: QueryTypes.SELECT },
  )) as Array<{ stmt: string; idle: string }>;
  check(
    'both timeouts reset when the transaction ends (nothing leaks onto the pooled connection)',
    gucToMs(afterTx.stmt) === 0 && gucToMs(afterTx.idle) === 0,
    afterTx,
  );

  // Ordering invariant: a statement must not be able to outlive a waiter's
  // willingness to queue, or waiters fail while the connection is still held.
  check(
    'statement cap is tighter than the pool acquire timeout',
    config.DB_STATEMENT_TIMEOUT_MS <= config.DB_POOL_ACQUIRE_MS,
    { stmt: config.DB_STATEMENT_TIMEOUT_MS, acquire: config.DB_POOL_ACQUIRE_MS },
  );
  check(
    'idle-in-transaction cap leaves room for in-request non-DB I/O (scan/PDF/MinIO)',
    config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS > config.DB_STATEMENT_TIMEOUT_MS,
    {
      idle: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      stmt: config.DB_STATEMENT_TIMEOUT_MS,
    },
  );
}

async function verifyRealtimeEndpoint() {
  console.log('\n── 2. Realtime endpoint and transport (F-06) ────────────────\n');

  // The engine.io handshake on the DEFAULT path. Apache strips the /dms
  // prefix before proxying, so this is the path the browser's /dms/socket.io/
  // request actually lands on.
  let handshake: { status: number; body: string } | null = null;
  try {
    const resp = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`);
    handshake = { status: resp.status, body: await resp.text() };
  } catch (error) {
    check('backend reachable on :7100 for the realtime probe', false, (error as Error).message);
    return;
  }

  check('Socket.IO answers on the default path /socket.io/', handshake.status === 200, handshake.status);

  // The handshake payload is engine.io's "0" open packet with JSON after it.
  const jsonStart = handshake.body.indexOf('{');
  let open: { sid?: string; upgrades?: string[]; pingInterval?: number; pingTimeout?: number } = {};
  if (jsonStart >= 0) {
    try {
      open = JSON.parse(handshake.body.slice(jsonStart, handshake.body.lastIndexOf('}') + 1));
    } catch {
      /* asserted below */
    }
  }

  check('the handshake issues a session id', typeof open.sid === 'string' && open.sid.length > 0, open.sid);

  // The whole point of the transport work: WebSocket must be OFFERED as an
  // upgrade. If it is not, long-polling is not a fallback — it is the only
  // thing available, which is what the client used to end up on.
  check(
    'WebSocket is offered as an upgrade (so polling is the fallback, not the mechanism)',
    Array.isArray(open.upgrades) && open.upgrades.includes('websocket'),
    open.upgrades,
  );

  check(
    'heartbeat is configured so a dead socket is detected rather than looking connected',
    typeof open.pingInterval === 'number' &&
      typeof open.pingTimeout === 'number' &&
      open.pingInterval > 0 &&
      open.pingTimeout > 0,
    { pingInterval: open.pingInterval, pingTimeout: open.pingTimeout },
  );

  // An unauthenticated peer must not keep a usable socket. The engine.io
  // handshake above is transport-level and deliberately succeeds; the refusal
  // happens at the Socket.IO layer, so drive the connect packet and expect an
  // error rather than a connection.
  if (open.sid) {
    const connectResp = await fetch(
      `${BASE}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(open.sid)}`,
      { method: 'POST', body: '40', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } },
    );
    const pollResp = await fetch(
      `${BASE}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(open.sid)}`,
    );
    const pollBody = await pollResp.text();
    // "44" is engine.io MESSAGE + socket.io CONNECT_ERROR; "40" would be a
    // successful CONNECT, which is the failure this asserts against.
    check(
      'a handshake with no token is refused rather than left connected',
      connectResp.ok && pollBody.includes('44') && !pollBody.startsWith('40'),
      pollBody.slice(0, 120),
    );
    check(
      'the refusal names the auth error rather than failing silently',
      pollBody.includes('ERR-AUTH-REQUIRED'),
      pollBody.slice(0, 120),
    );
  }
}

async function verifyHealthEndpointCost() {
  console.log('\n── 3. Health endpoint under repetition (R-01) ───────────────\n');

  let first: Record<string, string>;
  try {
    const resp = await fetch(`${BASE}/api/v1/operations/health`);
    first = (await resp.json()) as Record<string, string>;
  } catch (error) {
    check('backend reachable for the health probe', false, (error as Error).message);
    return;
  }

  check(
    'health still reports every dependency (response shape unchanged)',
    ['db', 'redis', 'minio', 'meilisearch', 'outbox'].every((k) => k in first),
    Object.keys(first),
  );
  check(
    'health reports how old its sample is instead of implying it is live',
    'sampledAgoMs' in first && Number.isFinite(Number(first.sampledAgoMs)),
    first.sampledAgoMs,
  );

  // A burst on a warm cache must be served from it: every response reports a
  // non-zero age and they all agree, which is only possible if one sample
  // served them all.
  const burst = await Promise.all(
    Array.from({ length: 25 }, async () => {
      const resp = await fetch(`${BASE}/api/v1/operations/health`);
      return (await resp.json()) as Record<string, string>;
    }),
  );

  check('a 25-request burst all succeeds', burst.every((b) => 'db' in b), burst.length);

  const distinctSamples = new Set(
    burst.map((b) => `${b.db}|${b.redis}|${b.minio}|${b.meilisearch}|${b.outboxPending ?? ''}`),
  );
  check(
    'the whole burst is served from one cached sample (no probe stampede)',
    distinctSamples.size === 1,
    [...distinctSamples],
  );

  const ages = burst.map((b) => Number(b.sampledAgoMs));
  check(
    'burst responses are cache hits, not fresh probes',
    ages.every((age) => age > 0),
    ages.slice(0, 5),
  );

  // And the cache must expire, or health would report a stale sample forever.
  await new Promise((r) => setTimeout(r, 5_500));
  const afterTtl = (await (await fetch(`${BASE}/api/v1/operations/health`)).json()) as Record<string, string>;
  check(
    'the cache expires so the sample stays current',
    Number(afterTtl.sampledAgoMs) < Math.max(...ages),
    { afterTtl: afterTtl.sampledAgoMs, burstMax: Math.max(...ages) },
  );
}

async function main() {
  await initModels();
  await connectDB();

  await verifyTransactionBounds();
  await verifyRealtimeEndpoint();
  await verifyHealthEndpointCost();

  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed\n`);

  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\n  verifier crashed:', error);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
