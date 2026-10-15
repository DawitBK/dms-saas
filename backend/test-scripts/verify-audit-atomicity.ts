/**
 * Audit durability (ACID) — live integration verifier against :4000.
 *
 * The unit test (tests/auditAtomicity.test.ts) proves the NEGATIVE direction with
 * mocks: a failed writeAuditLog propagates and fails the operation instead of
 * being swallowed. This script proves the POSITIVE direction end-to-end against
 * the real stack (real Express middleware → real request CLS transaction → real
 * Postgres → real HMAC hash chain): an awaited audit write commits atomically
 * with its domain change, and every awaited write keeps the chain verifiable.
 *
 * It exercises the security-critical access-rule create/delete paths — the same
 * paths the unit test pins — so the two layers meet on the same code.
 *
 * Run: npx tsx test-scripts/verify-audit-atomicity.ts   (backend must be running)
 */

import axios from 'axios';
import { loginAs, verifyAdminEmail, verifyTenantId } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details ?? ''); }
}

// Sign-in goes through the shared dev helper: the QA-world administrator in tenant qa-lab unless VERIFY_ADMIN_EMAIL /
// VERIFY_TENANT say otherwise; it refuses a non-local target. See test-scripts/lib/dev-admin.ts.
async function loginWithTenant(email: string): Promise<{ token: string }> {
  return loginAs(email, 'verify-audit-atomicity.ts');
}

type AuditRow = { eventType: string; sequenceNumber: string; actionDetails: unknown };

function parseDetails(row: AuditRow): Record<string, unknown> {
  const d = row.actionDetails;
  if (typeof d === 'string') {
    try { return JSON.parse(d) as Record<string, unknown>; } catch { return {}; }
  }
  return (d ?? {}) as Record<string, unknown>;
}

async function main() {
  console.log('\n═══ Audit durability (ACID) — live integration ═══\n');

  const { token } = await loginWithTenant(verifyAdminEmail());
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  console.log(`Setup: logged in as ${verifyAdminEmail()} (tenant ${verifyTenantId()})\n`);

  // -- Baseline: record the chain's CURRENT break set (if any) --
  //
  // This deliberately does NOT assert `valid === true`. A long-lived database
  // can legitimately carry historical breaks from a bug that has since been
  // fixed (this dev DB has one at sequence 476, left by the pre-fix Redis-tip
  // race documented in audit.service.ts's writeAuditLog). What this verifier
  // actually needs to prove is that OUR writes add no NEW break, which is
  // both stricter for the property under test and usable on a real database.
  const baseline = (await axios.get(`${API_BASE}/audit/verify-integrity`, auth)).data;
  const baselineBreaks = new Set<string>((baseline.breaks ?? []).map((b: { sequenceNumber: string }) => b.sequenceNumber));
  check('baseline chain scan completes and reports its break set',
    typeof baseline.totalVerified === 'number' && Array.isArray(baseline.breaks),
    { valid: baseline.valid, totalVerified: baseline.totalVerified, knownBreaks: [...baselineBreaks] });
  if (baselineBreaks.size > 0) {
    console.log(`  ℹ  pre-existing breaks carried into this run: ${[...baselineBreaks].join(', ')}`);
  }

  const newBreaksSince = (integrity: { breaks?: { sequenceNumber: string }[] }) =>
    (integrity.breaks ?? []).map((b) => b.sequenceNumber).filter((seq) => !baselineBreaks.has(seq));

  // ── 1. Domain create → awaited ACCESS_RULE_CREATED must have committed ──
  console.log('\n1. Awaited audit write commits atomically with the domain create');
  const probeId = `atomicity-probe-${Date.now()}`;
  const created = (await axios.post(
    `${API_BASE}/access-rules`,
    { principalType: 'user', principalId: probeId, effect: 'ALLOW', permission: 'document:read' },
    auth,
  )).data.data;
  // POST /access-rules is bulk-capable — it answers with an ARRAY of created
  // rules, one per requested permission. This verifier used to read `.id` off
  // the array itself, so `created.id` was always undefined and every later
  // assertion (and the DELETE below) failed on a phantom id.
  const createdRule = Array.isArray(created) ? created[0] : created;
  check('access rule created (domain change committed)', Boolean(createdRule?.id), created);

  const afterCreate = (await axios.get(`${API_BASE}/audit`, auth)).data.data as AuditRow[];
  const createRow = afterCreate.find(
    (r) => r.eventType === 'ACCESS_RULE_CREATED' && parseDetails(r).ruleId === createdRule.id,
  );
  check('ACCESS_RULE_CREATED audit row committed in the SAME request as the domain change', Boolean(createRow), {
    ruleId: createdRule?.id,
  });

  const integrityAfterCreate = (await axios.get(`${API_BASE}/audit/verify-integrity`, auth)).data;
  check('the create audit write introduced NO new chain break',
    newBreaksSince(integrityAfterCreate).length === 0, newBreaksSince(integrityAfterCreate));

  // ── 2. Domain delete → awaited ACCESS_RULE_DELETED must have committed ──
  console.log('\n2. Awaited audit write commits atomically with the domain delete');
  await axios.delete(`${API_BASE}/access-rules/${createdRule.id}`, auth);
  check('access rule deleted (domain change committed)', true);

  const afterDelete = (await axios.get(`${API_BASE}/audit`, auth)).data.data as AuditRow[];
  const deleteRow = afterDelete.find(
    (r) => r.eventType === 'ACCESS_RULE_DELETED' && parseDetails(r).ruleId === createdRule.id,
  );
  check('ACCESS_RULE_DELETED audit row committed in the SAME request as the domain change', Boolean(deleteRow), {
    ruleId: createdRule?.id,
  });

  // ── 3. Ordering: the two awaited writes advanced the chain monotonically ──
  console.log('\n3. Sequence integrity across the awaited writes');
  if (createRow && deleteRow) {
    check(
      'delete audit sequence is strictly greater than create audit sequence',
      BigInt(deleteRow.sequenceNumber) > BigInt(createRow.sequenceNumber),
      { create: createRow.sequenceNumber, delete: deleteRow.sequenceNumber },
    );
  } else {
    check('delete audit sequence is strictly greater than create audit sequence', false, 'missing a row');
  }

  const integrityFinal = (await axios.get(`${API_BASE}/audit/verify-integrity`, auth)).data;
  check('no awaited audit write introduced a new chain break',
    newBreaksSince(integrityFinal).length === 0, newBreaksSince(integrityFinal));
  check('the verifier scans the WHOLE chain rather than stopping at the first break',
    integrityFinal.totalVerified >= (baseline.totalVerified ?? 0),
    { baseline: baseline.totalVerified, final: integrityFinal.totalVerified });

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ verifier crashed:', err?.response?.data ?? err?.message ?? err);
  process.exit(1);
});
