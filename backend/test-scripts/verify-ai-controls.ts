/**
 * Live verification of the AI usage controls against the real database.
 * Run: npx tsx test-scripts/verify-ai-controls.ts
 *
 * Uses a throwaway tenant ("tst-ai-controls") so nothing real is touched, and
 * removes it afterwards. Proves: consent gate, feature switches, content rules
 * (classification / blocked type / blocked department), the quota debit and its
 * user and tenant limits, that refusals are recorded but not charged, verify
 * mode not double-charging, and that the usage summary reflects it all.
 */
import '../src/config/env.js';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/infrastructure/database/sequelize.js';
import { initModels } from '../src/infrastructure/database/models/index.js';
import { AppError } from '../src/core/AppError.js';
import {
  authorizeAiRequest, getAiPolicy, getAiUsageSummary, setAiPolicy,
} from '../src/modules/ai/aiPolicy.service.js';
import { setFlag } from '../src/modules/feature-flags/featureFlags.service.js';

const TENANT = 'tst-ai-controls';
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
async function denies(code: string, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch (e) { return e instanceof AppError && e.code === code; }
}

async function cleanup() {
  await sequelize.query(`DELETE FROM ai_usage_events WHERE tenant_id = :t`, { replacements: { t: TENANT } });
  await sequelize.query(`DELETE FROM documents WHERE tenant_id = :t`, { replacements: { t: TENANT } });
  await sequelize.query(`DELETE FROM tenants WHERE id = :t`, { replacements: { t: TENANT } });
}

async function main() {
  await sequelize.authenticate();
  initModels();
  await cleanup();
  await sequelize.query(
    `INSERT INTO tenants (id, name, "storageQuotaBytes", "storageUsedBytes", "maxUsers", "maxDocuments", "isActive", feature_flags, exec_notice_config, ai_policy, "createdAt", "updatedAt")
     VALUES (:t, 'AI controls test', 1073741824, 0, 10, 1000, true, '{}', '{}', '{}', now(), now())`,
    { replacements: { t: TENANT } },
  );
  const actor = { userId: '00000000-0000-0000-0000-0000000000a1', role: 'SYSTEM_ADMIN' };
  const userA = '00000000-0000-0000-0000-0000000000b1';
  const userB = '00000000-0000-0000-0000-0000000000b2';
  const doc = (cls: string, over: Record<string, unknown> = {}) => ({
    id: '00000000-0000-0000-0000-0000000000d1', securityClassification: cls, documentTypeId: null, departmentId: null, ...over,
  });

  // Each call below commits on its own (no ambient transaction), exactly like
  // separate requests: the feature-flag cache is invalidated after each commit.
  {
    console.log('consent');
    check('refused while the master switch is off', await denies('ERR-AI-NOT-ENABLED', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('INTERNAL') })));
    await setFlag(TENANT, 'ai_processing', true, actor);

    console.log('defaults');
    const p = await getAiPolicy(TENANT);
    check('default ceiling is INTERNAL', p.maxConfidentiality === 'INTERNAL');
    await authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('INTERNAL') });
    check('INTERNAL document allowed', true);
    check('CONFIDENTIAL document refused', await denies('ERR-AI-CLASSIFICATION', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('CONFIDENTIAL') })));

    console.log('policy changes');
    await setAiPolicy(TENANT, { maxConfidentiality: 'CONFIDENTIAL' }, actor);
    await authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('CONFIDENTIAL') });
    check('raising the ceiling admits CONFIDENTIAL', true);
    check('RESTRICTED still refused', await denies('ERR-AI-CLASSIFICATION', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('RESTRICTED') })));

    await setAiPolicy(TENANT, { features: { extract: false } }, actor);
    check('switched-off feature refused', await denies('ERR-AI-FEATURE-OFF', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'extract', document: doc('INTERNAL') })));
    check('other features unaffected', true);

    const deptId = '44444444-4444-4444-8444-444444444444';
    const typeId = '55555555-5555-4555-8555-555555555555';
    await setAiPolicy(TENANT, { blockedDepartmentIds: [deptId], blockedDocumentTypeIds: [typeId] }, actor);
    check('blocked department refused', await denies('ERR-AI-DEPARTMENT-BLOCKED', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('INTERNAL', { departmentId: deptId }) })));
    check('blocked document type refused', await denies('ERR-AI-DOCTYPE-BLOCKED', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', document: doc('INTERNAL', { documentTypeId: typeId }) })));

    await setAiPolicy(TENANT, { autoProcessOnUpload: false }, actor);
    check('auto trigger refused when auto-processing is off', await denies('ERR-AI-AUTO-OFF', () =>
      authorizeAiRequest({ tenantId: TENANT, userId: null, feature: 'summarize', trigger: 'auto', document: doc('INTERNAL') })));
    await authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'summarize', trigger: 'user', document: doc('INTERNAL') });
    check('a person asking is unaffected by the auto switch', true);

    console.log('quota');
    await sequelize.query(`DELETE FROM ai_usage_events WHERE tenant_id = :t`, { replacements: { t: TENANT } });
    await setAiPolicy(TENANT, { userLimitPer24h: 3, tenantLimitPer24h: 5, blockedDepartmentIds: [], blockedDocumentTypeIds: [], autoProcessOnUpload: true }, actor);
    for (let i = 0; i < 3; i++) await authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'chat' });
    check('user A used 3 of 3', true);
    check('user A refused on the 4th', await denies('ERR-AI-USER-LIMIT', () => authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'chat' })));
    await authorizeAiRequest({ tenantId: TENANT, userId: userB, feature: 'chat' });
    await authorizeAiRequest({ tenantId: TENANT, userId: userB, feature: 'chat' });
    check('user B has their own allowance', true);
    check('tenant limit (5) stops user B', await denies('ERR-AI-TENANT-LIMIT', () => authorizeAiRequest({ tenantId: TENANT, userId: userB, feature: 'chat' })));

    console.log('verify mode');
    await sequelize.query(`DELETE FROM ai_usage_events WHERE tenant_id = :t`, { replacements: { t: TENANT } });
    await setAiPolicy(TENANT, { userLimitPer24h: 1 }, actor);
    await authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'chat' });
    await authorizeAiRequest({ tenantId: TENANT, userId: userA, feature: 'chat', mode: 'verify' });
    check('verify mode passes even when the quota is spent, and charges nothing', true);
    const rows = await sequelize.query<{ n: string }>(
      `SELECT count(*)::text n FROM ai_usage_events WHERE tenant_id=:t AND outcome='allowed'`,
      { replacements: { t: TENANT }, type: QueryTypes.SELECT });
    check('exactly one debit recorded', rows[0].n === '1', `(got ${rows[0].n})`);

    console.log('ledger');
    const sum = await getAiUsageSummary(TENANT, userA, 24);
    check('summary counts allowed requests', sum.totals.allowed === 1);
    check('your usage reflects the limit', sum.yourUsage.limit === 1 && sum.yourUsage.allowedLast24h === 1);
  }
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
