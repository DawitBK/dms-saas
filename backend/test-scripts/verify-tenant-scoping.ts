/**
 * Tenant-scoping verification for the `users` module — R-06 of
 * Documentations/audits/AUDIT-FINDINGS-2026-09-03.md.
 *
 * `users` has no tenant_id (membership is many-to-many through
 * `user_tenants`), and neither listUsers nor getUser joined it. So
 * GET /users returned EVERY user row in the database to any user:manage
 * holder, and GET /users/:id resolved user ids across tenant boundaries.
 * Production contained this behind the non-superuser `edams_app` role and the
 * RLS policy in 20260710000001-rls-remaining-tenant-tables.sql; development
 * runs as `postgres`, where RLS is inert, so it was wide open there.
 *
 * This runs against the service layer directly (no HTTP server needed) and
 * compares what the service returns against ground truth taken straight from
 * SQL, so it stays honest as the dev data set changes.
 *
 * Run: npx tsx test-scripts/verify-tenant-scoping.ts
 */

import 'dotenv/config';
import { connectDB, initModels, sequelize } from '../src/infrastructure/database/index.js';
import { getUser, listUsers } from '../src/modules/users/users.service.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details ?? ''); }
}

type Counts = { all_users: number; a: number; b: number };

async function main() {
  await initModels();
  await connectDB();

  // Pick the two most-populated tenants so the test is meaningful wherever it runs.
  const tenantRows = (await sequelize.query(
    `SELECT ut.tenant_id AS id, count(*)::int AS n
       FROM user_tenants ut
       JOIN users u ON u.id = ut.user_id AND u.deleted_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
    { type: 'SELECT' as never },
  )) as unknown as Array<{ id: string; n: number }>;

  if (tenantRows.length < 2) {
    console.log('\n⚠️  Need at least two tenants with members to verify cross-tenant scoping.');
    console.log(`    Found: ${tenantRows.map((r) => `${r.id}=${r.n}`).join(', ') || 'none'}`);
    await sequelize.close();
    process.exit(0);
  }

  const big = tenantRows[0]!;
  const small = tenantRows[tenantRows.length - 1]!;

  const truth = ((await sequelize.query(
    `SELECT
       (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS all_users,
       (SELECT count(*)::int FROM user_tenants ut JOIN users u ON u.id=ut.user_id AND u.deleted_at IS NULL WHERE ut.tenant_id = :a) AS a,
       (SELECT count(*)::int FROM user_tenants ut JOIN users u ON u.id=ut.user_id AND u.deleted_at IS NULL WHERE ut.tenant_id = :b) AS b`,
    { replacements: { a: big.id, b: small.id }, type: 'SELECT' as never },
  )) as unknown as Counts[])[0]!;

  console.log(`\n  ${truth.all_users} live users total`);
  console.log(`  "${big.id}" has ${truth.a} member(s); "${small.id}" has ${truth.b}\n`);

  const admin = (tenantId: string) => ({ userId: 'verifier', role: 'SYSTEM_ADMIN', tenantId });

  const a = await listUsers(admin(big.id), {});
  check(`listUsers is scoped to "${big.id}"`, a.data.length === truth.a,
    `got ${a.data.length}, expected ${truth.a}`);
  check('its total matches the scoped result, not the global count',
    a.total === truth.a, `total=${a.total}, expected ${truth.a}`);

  const b = await listUsers(admin(small.id), {});
  check(`listUsers is scoped to "${small.id}" (would have been ${truth.all_users} before R-06)`,
    b.data.length === truth.b, `got ${b.data.length}, expected ${truth.b}`);
  check('its total is scoped too', b.total === truth.b, `total=${b.total}, expected ${truth.b}`);
  check('no user leaks in that is not a member of the requested tenant',
    b.data.length <= truth.b);

  // A user that exists but is NOT a member of the smaller tenant.
  const outsider = a.data.find((u) => !b.data.some((x) => x.id === u.id));
  check('found a user outside the smaller tenant to probe with',
    Boolean(outsider), outsider?.email ?? 'none — tenants fully overlap');

  if (outsider) {
    const own = await getUser(outsider.id, admin(big.id));
    check('getUser resolves a member of the caller\'s own tenant', own.id === outsider.id);

    let leaked = true;
    let code = '';
    try {
      await getUser(outsider.id, admin(small.id));
    } catch (err) {
      leaked = false;
      code = (err as { code?: string }).code ?? '';
    }
    check('getUser refuses a user id belonging to another tenant', !leaked,
      leaked ? 'it returned a profile!' : code);
    check('...as 404, so the endpoint cannot probe which ids exist elsewhere',
      code === 'ERR-USER-NOT-FOUND', code);
  }

  // The tenant join must not disturb pagination.
  const size = Math.max(1, Math.min(5, truth.a - 1));
  const p1 = await listUsers(admin(big.id), { take: size, skip: 0 });
  check('page size respected under the tenant join',
    p1.data.length === Math.min(size, truth.a), `got ${p1.data.length}, expected ${Math.min(size, truth.a)}`);
  check('paged total is the full scoped count, not the page size',
    p1.total === truth.a, `total=${p1.total}, expected ${truth.a}`);

  const p2 = await listUsers(admin(big.id), { take: size, skip: size });
  check('the next page has no rows in common with the first (join did not duplicate)',
    p2.data.every((u) => !p1.data.some((x) => x.id === u.id)));

  const seen = new Set(a.data.map((u) => u.id));
  check('no duplicate rows in an unpaged listing', seen.size === a.data.length,
    `${a.data.length} rows, ${seen.size} distinct`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await sequelize.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
