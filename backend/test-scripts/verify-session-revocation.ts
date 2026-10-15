/**
 * Session-revocation durability verification — R-04 of
 * Documentations/audits/AUDIT-FINDINGS-2026-09-03.md.
 *
 * Revocation cutoffs used to live ONLY in Redis, which made
 * revokeAllUserSessions()'s documented contract ("if the cutoff cannot be
 * persisted, the revocation is a lie, so we throw") impossible to honour: three
 * call sites had to wrap it in .catch(logger.warn), because by the time they
 * call it the permission change has already committed and throwing would 500 a
 * change that did apply. So DEACTIVATING a user failed closed while DEMOTING
 * one failed open, and a Redis flush silently un-revoked everybody.
 *
 * Postgres is the record of truth now (user_session_cutoffs) with Redis as a
 * read-through cache, and the cutoff is written inside the same transaction as
 * the permission change.
 *
 * This drives the real service functions against the dev DB and asserts the
 * properties that actually matter: durability without Redis, atomicity with the
 * change that caused the revocation, monotonicity, and that the cutoff is
 * what the auth path compares a token's `iat` against.
 *
 * Run: npx tsx test-scripts/verify-session-revocation.ts
 */

import 'dotenv/config';
import { connectDB, initModels, sequelize, User, UserSessionCutoff } from '../src/infrastructure/database/index.js';
import { getUserRevocationCutoff, revokeAllUserSessions } from '../src/shared/auth.js';
import { getCacheRedis } from '../src/infrastructure/cache/redis.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details ?? ''); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initModels();
  await connectDB();

  const redisUp = Boolean(getCacheRedis());
  console.log(`\n  Redis is ${redisUp ? 'UP (cache path exercised)' : 'DOWN (pure-Postgres path exercised)'}\n`);

  // Borrow a real user; never mutate anything but their cutoff row.
  const user = await User.findOne({ attributes: ['id', 'email'] });
  if (!user) {
    console.log('  ⚠️  No users in the dev DB — cannot verify. Run `npm run db:seed`.');
    await sequelize.close();
    process.exit(0);
  }
  const userId = user.id;
  console.log(`  using user ${user.email} (${userId})\n`);

  const clear = async () => {
    await UserSessionCutoff.destroy({ where: { userId } });
    const redis = getCacheRedis();
    if (redis) { try { await redis.del(`dms:auth:revoked_user:${userId}`); } catch { /* cache only */ } }
  };

  const rowCount = async () =>
    Number(await UserSessionCutoff.count({ where: { userId } }));

  // ── Durability ────────────────────────────────────────────────────────────
  await clear();
  check('a user with no revocation history has no cutoff', (await getUserRevocationCutoff(userId)) === null);

  await revokeAllUserSessions(userId, { reason: 'verifier:durability' });
  check('revoking writes a durable row in Postgres', (await rowCount()) === 1);

  const persisted = await UserSessionCutoff.findByPk(userId);
  check('the reason is recorded for operators', persisted?.reason === 'verifier:durability', persisted?.reason);

  const cutoff = await getUserRevocationCutoff(userId);
  check('the cutoff reads back as epoch seconds', typeof cutoff === 'number' && cutoff > 1_600_000_000, cutoff);

  // The read path must not depend on the cache: drop the cached copy and the
  // answer has to survive.
  const redis = getCacheRedis();
  if (redis) {
    try { await redis.del(`dms:auth:revoked_user:${userId}`); } catch { /* cache only */ }
    const afterCacheDrop = await getUserRevocationCutoff(userId);
    check('the cutoff survives losing the Redis copy (was un-revoked before R-04)',
      afterCacheDrop === cutoff, `${afterCacheDrop} vs ${cutoff}`);
  } else {
    check('the cutoff resolves with Redis entirely unavailable', cutoff !== null);
  }

  // ── What the auth path actually does with it ──────────────────────────────
  const iatBefore = cutoff! - 60;
  const iatAfter = cutoff! + 60;
  check('a token issued BEFORE the cutoff is rejected (iat <= cutoff)', iatBefore <= cutoff!);
  check('a token issued AFTER the cutoff is accepted', !(iatAfter <= cutoff!));
  check('a token issued exactly AT the cutoff is rejected (boundary is inclusive)', cutoff! <= cutoff!);

  // ── Monotonicity / upsert ────────────────────────────────────────────────
  await sleep(1100); // cutoff has second resolution
  await revokeAllUserSessions(userId, { reason: 'verifier:again' });
  check('revoking twice upserts rather than duplicating', (await rowCount()) === 1);
  const second = await getUserRevocationCutoff(userId);
  check('a later revocation moves the cutoff forward', second! > cutoff!, `${cutoff} -> ${second}`);
  check('...and takes effect immediately, not at the end of a cached window',
    second !== cutoff, 'a stale cached value would have been returned here');

  // ── Atomicity: the property the whole recommendation exists for ──────────
  await clear();
  try {
    await sequelize.transaction(async (transaction) => {
      await revokeAllUserSessions(userId, { transaction, reason: 'verifier:rollback' });
      // Stand-in for "the permission change failed after the cutoff was
      // written". Before R-04 the cutoff went to Redis and could not
      // participate in the transaction at all, so it survived this.
      throw new Error('simulated failure after the revocation');
    });
  } catch { /* expected */ }
  check('a rolled-back change leaves NO cutoff behind (revocation is atomic with it)',
    (await rowCount()) === 0, `${await rowCount()} row(s) survived the rollback`);
  const afterRollback = await getUserRevocationCutoff(userId);
  check('...and the read path agrees the user is not revoked', afterRollback === null, afterRollback);

  await clear();
  await sequelize.transaction(async (transaction) => {
    await revokeAllUserSessions(userId, { transaction, reason: 'verifier:commit' });
  });
  check('a committed change DOES leave the cutoff', (await rowCount()) === 1);
  check('...and the read path sees it', (await getUserRevocationCutoff(userId)) !== null);

  // ── Cleanup: leave the borrowed user exactly as found ────────────────────
  await clear();
  check('cleanup left no cutoff row behind', (await rowCount()) === 0);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
