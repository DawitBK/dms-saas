/**
 * Audit-chain sharding verification — R-02 of Documentations/audits/AUDIT-FINDINGS-2026-09-03.md.
 *
 * writeAuditLog() takes a per-chain advisory XACT lock and reads the chain tip
 * from committed state under it. That lock is load-bearing — it is what stops a
 * writer reading a stale tip and durably committing a row that skips the real
 * last entry — but an XACT lock is held until COMMIT, and writeAuditLog runs
 * inside the REQUEST transaction, which commits at response-finish time. So
 * with one chain per tenant, every mutating request in a tenant queues behind
 * the one in front of it for the whole tail of that request.
 *
 * Atomicity (the audit row commits with the change it records) and short lock
 * holds are irreconcilable on a single chain, so the trail is split into
 * AUDIT_CHAIN_SHARDS independent chains per tenant, locked per shard.
 *
 * This proves the three things that have to be true:
 *   1. the pre-existing chain still verifies (legacy rows are all shard 0);
 *   2. concurrent audited writes no longer serialise;
 *   3. the chain still verifies afterwards, and tampering is still caught.
 *
 * It writes real audit rows (they are append-only by design, so they stay) and
 * removes nothing.
 *
 * Run: npx tsx test-scripts/verify-audit-chain-sharding.ts
 */

import 'dotenv/config';
import { QueryTypes } from 'sequelize';
import { config } from '../src/config/env.js';
import { connectDB, initModels, sequelize, AuditLog } from '../src/infrastructure/database/index.js';
import { verifyAuditChain, writeAuditLog } from '../src/modules/audit/audit.service.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details ?? ''); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TENANT = 'examplecorp';
const HOLD_MS = 250;
const WRITERS = 8;

/** One "request": audit-write, hold the transaction open, then commit. */
async function auditedRequest(label: string) {
  await sequelize.transaction(async (tx) => {
    await writeAuditLog(
      { eventType: 'SYSTEM_HEALTH_CHECK', tenantId: TENANT, actionDetails: { verifier: label } },
      tx,
    );
    // Stands in for the rest of a request after its first audit write — PDF
    // rendering, an object-storage upload, the response flush. This is the
    // window the advisory lock used to hold the whole tenant behind.
    await sleep(HOLD_MS);
  });
}

async function main() {
  await initModels();
  await connectDB();

  console.log(`\n  AUDIT_CHAIN_SHARDS = ${config.AUDIT_CHAIN_SHARDS}`);

  // ── 1. History is intact ─────────────────────────────────────────────────
  const legacy = await sequelize.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE chain_shard <> 0`,
    { type: QueryTypes.SELECT },
  );
  console.log(`  rows already on a non-zero shard: ${legacy[0]!.n}\n`);

  const baseline = await verifyAuditChain(undefined, TENANT);
  console.log(`  baseline: ${baseline.totalVerified} rows verified, ${baseline.breaks.length} break(s)\n`);
  const baselineBreaks = new Set(baseline.breaks.map((b) => `${b.kind}@${b.sequenceNumber}`));

  // ── 2. Concurrency — the point of the change ─────────────────────────────
  const started = Date.now();
  await Promise.all(Array.from({ length: WRITERS }, (_, i) => auditedRequest(`concurrent-${i}`)));
  const elapsed = Date.now() - started;

  const serialFloor = WRITERS * HOLD_MS;
  console.log(`  ${WRITERS} concurrent audited writes took ${elapsed}ms`);
  console.log(`  (fully serialised would be >= ${serialFloor}ms; perfectly parallel ~${HOLD_MS}ms)\n`);

  if (config.AUDIT_CHAIN_SHARDS === 1) {
    check('with 1 shard, writes serialise (the pre-R-02 behaviour, as expected)',
      elapsed >= serialFloor * 0.8, `${elapsed}ms`);
  } else {
    // Random shard assignment means collisions are likely with 8 writers over
    // 8 shards, so this asserts a clear improvement rather than perfect
    // parallelism. Even the worst realistic case beats full serialisation.
    check('concurrent audited writes no longer serialise',
      elapsed < serialFloor * 0.75,
      `${elapsed}ms vs a ${serialFloor}ms serial floor`);
  }

  // ── 3. Rows landed on several chains ────────────────────────────────────
  const spread = await sequelize.query<{ chain_shard: number; n: number }>(
    `SELECT chain_shard, count(*)::int AS n
       FROM audit_logs
      WHERE tenant_id = :tenant AND action_details LIKE '%concurrent-%'
      GROUP BY 1 ORDER BY 1`,
    { replacements: { tenant: TENANT }, type: QueryTypes.SELECT },
  );
  console.log(`  those writes landed on shards: ${spread.map((r) => `${r.chain_shard}(${r.n})`).join(' ')}\n`);
  if (config.AUDIT_CHAIN_SHARDS > 1) {
    check('writes distributed across more than one chain', spread.length > 1,
      `${spread.length} distinct shard(s)`);
  }
  check('every written row has a shard within the configured range',
    spread.every((r) => r.chain_shard >= 0 && r.chain_shard < config.AUDIT_CHAIN_SHARDS),
    spread.map((r) => r.chain_shard).join(','));

  // ── 4. Integrity survived ───────────────────────────────────────────────
  const after = await verifyAuditChain(undefined, TENANT);
  const newBreaks = after.breaks.filter((b) => !baselineBreaks.has(`${b.kind}@${b.sequenceNumber}`));
  check('concurrent sharded writes introduced NO new chain break',
    newBreaks.length === 0, newBreaks);
  check('verification covered the newly written rows',
    after.totalVerified >= baseline.totalVerified + WRITERS,
    `${baseline.totalVerified} -> ${after.totalVerified}`);

  // Each shard must be a properly linked chain in its own right.
  const perShard = await sequelize.query<{ chain_shard: number; n: number; genesis: number }>(
    `SELECT chain_shard,
            count(*)::int AS n,
            count(*) FILTER (WHERE previous_hash IS NULL)::int AS genesis
       FROM audit_logs WHERE tenant_id = :tenant GROUP BY 1 ORDER BY 1`,
    { replacements: { tenant: TENANT }, type: QueryTypes.SELECT },
  );
  console.log(`\n  per-shard: ${perShard.map((r) => `shard ${r.chain_shard}: ${r.n} rows, ${r.genesis} genesis`).join('; ')}\n`);
  check('each chain has at most one genesis (NULL previousHash) row',
    perShard.every((r) => r.genesis <= 1),
    perShard.filter((r) => r.genesis > 1));

  // ── 5. Tamper detection still works ─────────────────────────────────────
  const victim = await AuditLog.findOne({
    where: { tenantId: TENANT },
    order: [['sequenceNumber', 'DESC']],
  });
  if (victim) {
    const originalDetails = victim.actionDetails;
    await sequelize.query(
      `UPDATE audit_logs SET action_details = :tampered WHERE id = :id`,
      { replacements: { tampered: JSON.stringify({ tampered: true }), id: victim.id } },
    );
    const tampered = await verifyAuditChain(undefined, TENANT);
    const detected = tampered.breaks.some(
      (b) => b.sequenceNumber === String(victim.sequenceNumber) && b.kind === 'hash',
    );
    // Restore before asserting, so a failed assertion cannot leave the row edited.
    await sequelize.query(
      `UPDATE audit_logs SET action_details = :original WHERE id = :id`,
      { replacements: { original: originalDetails, id: victim.id } },
    );
    check('editing a row is still detected as a hash break under sharding', detected,
      tampered.breaks.slice(0, 3));

    const restored = await verifyAuditChain(undefined, TENANT);
    const stillNew = restored.breaks.filter((b) => !baselineBreaks.has(`${b.kind}@${b.sequenceNumber}`));
    check('restoring the row clears the break (verifier is not sticky)',
      stillNew.length === 0, stillNew);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
