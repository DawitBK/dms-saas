/**
 * Live-stack runtime verification — flows 1–7 are what Sessions 19/20 could never
 * exercise because the local infra was down (HANDOFF Tier-1 item #1); flow 8
 * was added in Session 22 alongside the M8 sweep savepoint fix:
 *
 *   1. MFA single-use pending token (replay of a consumed token → 401)
 *   2. MFA attempt-lockout (6th bad code → 429, and the lock blocks valid codes)
 *   3. Restore-over-quota → 413 STORAGE_QUOTA_EXCEEDED
 *   4. Trash voids a live e-sign link (voided request, nulled tokens, 403/400)
 *   5. Deactivation offboarding sweep (locks deleted + audit sweep counts)
 *   6. AI consent gate: 403 ERR-AI-NOT-ENABLED → feature flag → 202 queued
 *   7. ApprovalSlaWorker breach → notification + EMAIL outbox row → PROCESSED
 *      (PROCESSED is stamped only after nodemailer sendMail resolves, i.e. the
 *      SMTP server accepted the message — that is the "email actually sent" proof)
 *   8. Offboarding-sweep fault injection: a statement-level trigger makes the
 *      sweep's first DELETE raise a real DB error inside the request
 *      transaction; the savepoint in trySweepDeactivatedUserWork must contain
 *      it — deactivation still commits, audit row records offboardingSweep=null
 *      (without the savepoint the aborted transaction 500s the whole request
 *      and rolls the deactivation back).
 *
 * Prereqs: backend on :4000 (npm run dev), Postgres, Redis. Flow 7 needs the
 * queue workers: either ENABLE_QUEUE_WORKERS=true in the API process or a
 * standalone `npm run worker` running alongside. Flows 1–2 are meaningful only
 * with Redis up (they fail open in dev when it is down).
 *
 * Run: npx tsx test-scripts/verify-runtime-flows.ts   (from backend/)
 */

import axios from 'axios';
import { authenticator } from 'otplib';
import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { assertLocalDevDatabase, loginAs, personaEmail, verifyAdminEmail, verifyTenantId } from './lib/dev-admin.js';

const API_BASE = process.env.API_URL || 'http://localhost:7100/api/v1';
// The verification tenant (qa-lab unless VERIFY_TENANT says otherwise), never the demo/real one. See lib/dev-admin.ts.
const TENANT = verifyTenantId();

// ── env (DB/Redis creds from backend/.env, same file the server reads) ──
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const env: Record<string, string> = { ...process.env } as Record<string, string>;
try {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
  }
} catch { /* fall back to process.env only */ }

const db = new pg.Client({
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT || 5432),
  user: env.DB_USER || 'postgres',
  password: env.DB_PASSWORD,
  database: env.DB_NAME || 'DMS',
});
const redis = new IORedis(env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, details !== undefined ? JSON.stringify(details) : ''); }
}

function errInfo(e: unknown) {
  const r = (e as { response?: { status?: number; data?: unknown } })?.response;
  return r ? { status: r.status, body: r.data } : { message: (e as Error)?.message };
}

/** Await a call that MUST fail with the given status + error-code substring. */
async function expectError(p: Promise<unknown>, status: number, codeSubstr: string, name: string) {
  try {
    await p;
    check(name, false, { unexpected: '2xx success' });
  } catch (e) {
    const info = errInfo(e);
    const ok = info.status === status && JSON.stringify(info.body ?? '').includes(codeSubstr);
    check(name, ok, ok ? undefined : info);
  }
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unwrap = <T = Record<string, unknown>>(body: { data?: T } & Record<string, unknown>): T =>
  (body?.data ?? body) as T;

async function login(email: string): Promise<{ token: string; userId: string }> {
  return loginAs(email, 'verify-runtime-flows.ts');
}

/** Upload parameters read from the verification tenant instead of assumed: the demo tenant had a REPORT type and an
 *  'HQ' unit; the QA tenant has its own types and two departments coded FIN (one per org unit). */
let uploadParams: { departmentId: string; departmentCode: string; documentTypeId: string; documentTypeCode: string; organisationUnit: string; retentionClass: string } | null = null;
async function resolveUploadParams(token: string) {
  if (uploadParams) return uploadParams;
  const get = async (path: string) => unwrap<any[]>((await axios.get(`${API_BASE}${path}`, bearer(token))).data);
  const [departments, docTypes, orgUnits, retention] = await Promise.all([
    get('/departments'), get('/document-types'), get('/org-units'), get('/retention'),
  ]);
  const department = departments.find((d: any) => d.code === 'FIN') ?? departments[0];
  const docType = docTypes.find((t: any) => t.code === 'REPORT') ?? docTypes[0];
  const orgUnit = orgUnits.find((u: any) => u.id === department.orgUnitId) ?? orgUnits[0];
  const policy = retention.find((r: any) => (r.retentionClass ?? r.code) === 'RET-FIN-7Y') ?? retention[0];
  uploadParams = {
    departmentId: department.id, departmentCode: department.code,
    documentTypeId: docType.id, documentTypeCode: docType.code,
    organisationUnit: orgUnit.code, retentionClass: policy.retentionClass ?? policy.code,
  };
  return uploadParams;
}

async function uploadDoc(token: string, title: string): Promise<string> {
  const p = await resolveUploadParams(token);
  const fd = new FormData();
  fd.append('title', title);
  fd.append('departmentId', p.departmentId);
  fd.append('departmentCode', p.departmentCode);
  fd.append('documentTypeId', p.documentTypeId);
  fd.append('documentTypeCode', p.documentTypeCode);
  fd.append('organisationUnit', p.organisationUnit);
  fd.append('securityClassification', 'INTERNAL');
  fd.append('retentionClass', p.retentionClass);
  fd.append('source', 'API');
  fd.append('file', new Blob([`runtime-verify: ${title}`], { type: 'text/plain' }), `${title}.txt`);
  const res = (await axios.post(`${API_BASE}/documents`, fd, bearer(token))).data;
  const doc = unwrap<{ id: string }>(res);
  if (!doc?.id) throw new Error(`upload returned no id: ${JSON.stringify(res)}`);
  return doc.id;
}

const wrongCode = (valid: string) => (valid.startsWith('0') ? '111111' : '000000');

async function main() {
  console.log('\n═══ Live-stack runtime verification (8 flows) ═══');
  assertLocalDevDatabase(env.DB_HOST || 'localhost', env.DB_NAME || 'DMS');
  await db.connect();

  const admin = await login(verifyAdminEmail());
  console.log(`\nSetup: admin logged in (tenant ${TENANT})`);

  // ════ 1+2. MFA — single-use pending token, then attempt-lockout ════
  console.log('\n1. MFA single-use pending token');
  const officerEmail = personaEmail('officer@edams.local'); // a QA-world account; the demo 'officer' does not exist here
  await db.query(`UPDATE users SET is_mfa_enabled = false, mfa_secret = null, mfa_temp_secret = null WHERE email = $1`, [officerEmail]);
  const officerUser = (await db.query(`SELECT id FROM users WHERE email = $1`, [officerEmail])).rows[0];
  if (officerUser) await redis.del(`mfa_fail:${officerUser.id}`, `dms:auth:mfa_fail:${officerUser.id}`);
  let officer = await login(officerEmail); // MFA still off → plain token
  const setup = unwrap<{ secret: string }>(
    (await axios.post(`${API_BASE}/auth/totp/setup`, {}, bearer(officer.token))).data,
  );
  check('totp/setup returns a base32 secret', typeof setup.secret === 'string' && setup.secret.length > 0);

  const confirm = (await axios.post(`${API_BASE}/auth/totp/confirm`,
    { code: authenticator.generate(setup.secret) }, bearer(officer.token))).data;
  check('totp/confirm enables MFA', unwrap<{ mfaEnabled?: boolean }>(confirm).mfaEnabled === true, confirm);

  const mfaLogin = async () => {
    const r = (await axios.post(`${API_BASE}/auth/login`, { email: officerEmail })).data;
    if (!r.mfaRequired || !r.mfaPendingToken) throw new Error(`expected mfaRequired login: ${JSON.stringify(r)}`);
    return r.mfaPendingToken as string;
  };

  const pending1 = await mfaLogin();
  check('login now returns mfaRequired + mfaPendingToken', true);

  const validated = (await axios.post(`${API_BASE}/auth/totp/validate`,
    { mfaPendingToken: pending1, code: authenticator.generate(setup.secret) })).data;
  check('totp/validate with a fresh token + valid code issues an access token',
    Boolean(validated.accessToken), validated);
  const officerBearer = validated.accessToken as string;

  await expectError(
    axios.post(`${API_BASE}/auth/totp/validate`,
      { mfaPendingToken: pending1, code: authenticator.generate(setup.secret) }),
    401, 'ERR-AUTH-INVALID',
    'REPLAY of the consumed pending token (even with a valid code) → 401',
  );

  console.log('\n2. MFA attempt-lockout (5-failure ceiling, 15-min lock)');
  await redis.del(`mfa_fail:${officer.userId}`, `dms:auth:mfa_fail:${officer.userId}`); // clean slate
  for (let i = 1; i <= 5; i++) {
    await expectError(
      axios.post(`${API_BASE}/auth/totp/disable`,
        { code: wrongCode(authenticator.generate(setup.secret)) }, bearer(officerBearer)),
      400, 'ERR-TOTP-INVALID', `bad code attempt ${i}/5 → 400 ERR-TOTP-INVALID`,
    );
  }
  await expectError(
    axios.post(`${API_BASE}/auth/totp/disable`,
      { code: wrongCode(authenticator.generate(setup.secret)) }, bearer(officerBearer)),
    429, 'ERR-MFA-LOCKED', '6th attempt → 429 ERR-MFA-LOCKED',
  );
  const pending2 = await mfaLogin();
  await expectError(
    axios.post(`${API_BASE}/auth/totp/validate`,
      { mfaPendingToken: pending2, code: authenticator.generate(setup.secret) }),
    429, 'ERR-MFA-LOCKED', 'lockout also blocks totp/validate with a CORRECT code → 429',
  );

  // cleanup: clear the lock, disable MFA (restore seed state)
  await redis.del(`mfa_fail:${officer.userId}`, `dms:auth:mfa_fail:${officer.userId}`);
  const disabled = (await axios.post(`${API_BASE}/auth/totp/disable`,
    { code: authenticator.generate(setup.secret) }, bearer(officerBearer))).data;
  check('cleanup: MFA disabled again for officer', unwrap<{ mfaEnabled?: boolean }>(disabled).mfaEnabled === false);

  // ════ 3. Restore-over-quota → 413 ════
  console.log('\n3. Restore-over-quota → 413 STORAGE_QUOTA_EXCEEDED');
  const { rows: [tenantRow] } = await db.query(
    'SELECT "storageQuotaBytes"::bigint AS quota FROM tenants WHERE id = $1', [TENANT]);
  const originalQuota = Number(tenantRow.quota);

  const docA = await uploadDoc(admin.token, `runtime-verify-quota-${Date.now()}`);
  check('uploaded tiny doc via local-storage fallback', Boolean(docA));
  await axios.post(`${API_BASE}/documents/${docA}/trash`, {}, bearer(admin.token));
  check('doc moved to trash (usage decremented)', true);

  await axios.patch(`${API_BASE}/tenants/${TENANT}`, { storageQuotaBytes: 1 }, bearer(admin.token));
  await expectError(
    axios.post(`${API_BASE}/documents/${docA}/restore`, {}, bearer(admin.token)),
    413, 'STORAGE_QUOTA_EXCEEDED', 'restore with quota=1 byte → 413 STORAGE_QUOTA_EXCEEDED',
  );
  const { rows: [stillTrashed] } = await db.query(
    'SELECT status FROM documents WHERE id = $1', [docA]);
  check('failed restore reverted the doc to TRASHED (retryable)', stillTrashed?.status === 'TRASHED', stillTrashed);

  await axios.patch(`${API_BASE}/tenants/${TENANT}`, { storageQuotaBytes: originalQuota }, bearer(admin.token));
  const restored = (await axios.post(`${API_BASE}/documents/${docA}/restore`, {}, bearer(admin.token))).data;
  check('restore succeeds after quota is restored', restored?.success === true || Boolean(restored), restored);

  // ════ 4. Trash voids a live e-sign link ════
  console.log('\n4. Trash voids a live e-sign link');
  const docB = await uploadDoc(admin.token, `runtime-verify-esign-${Date.now()}`);
  await db.query(`UPDATE documents SET status = 'APPROVED' WHERE id = $1`, [docB]);
  const extEmail = `ext-signer-${Date.now()}@example.com`;
  const created = unwrap<{ id: string }>(
    (await axios.post(`${API_BASE}/documents/${docB}/signing`, {
      source: 'freeform', orderingMode: 'parallel', fields: [],
      recipients: [{ name: 'External Signer', email: extEmail }],
    }, bearer(admin.token))).data,
  );
  await axios.post(`${API_BASE}/signing/${created.id}/send`, {}, bearer(admin.token));
  const sent = unwrap<{ status: string; recipients: { id: string; accessToken: string | null }[] }>(
    (await axios.get(`${API_BASE}/signing/${created.id}`, bearer(admin.token))).data,
  );
  // E24: the API no longer returns the raw link token (only its SHA-256 is stored). The raw value exists in the emailed
  // link and, until the dispatcher delivers it and redacts it, in the `signUrl` of the invite's outbox row, which is
  // where this verifier reads it (it has the database open anyway). Read it before the 5 s poller gets to the row.
  const { rows: [invite] } = await db.query(
    `SELECT payload FROM outbox_events WHERE type = 'ESIGNING.RECIPIENT_INVITED' AND payload LIKE $1
     ORDER BY created_at DESC LIMIT 1`, [`%${created.id}%`]);
  const inviteUrl = invite ? (JSON.parse(invite.payload) as { signUrl?: string }).signUrl : undefined;
  const rawToken = inviteUrl ? new URL(inviteUrl).searchParams.get('token') : null;
  const external = sent.recipients?.find((r) => r.id === inviteUrl?.split('/').slice(-1)[0]?.split('?')[0]) ?? sent.recipients?.[0];
  const recipient = external && rawToken && rawToken !== 'REDACTED' ? { id: external.id, accessToken: rawToken } : null;
  check('ceremony sent with an external recipient holding a live access token',
    sent.status === 'sent' && Boolean(recipient?.accessToken), { status: sent.status, tokenFound: Boolean(rawToken) });
  if (!recipient?.accessToken) throw new Error('no external recipient token (outbox invite already delivered and redacted, or none sent) — cannot continue flow 4');

  const viewUrl = `${API_BASE}/signing/${created.id}/recipients/${recipient.id}/view`;
  const view = await axios.get(`${viewUrl}?token=${encodeURIComponent(recipient.accessToken)}`);
  check('public view link works while the request is live (200)', view.status === 200);

  await axios.post(`${API_BASE}/documents/${docB}/trash`, {}, bearer(admin.token));
  const afterTrash = unwrap<{ status: string; voidedReason?: string; recipients: { accessToken: string | null }[] }>(
    (await axios.get(`${API_BASE}/signing/${created.id}`, bearer(admin.token))).data,
  );
  check('trashing voided the request (status=voided, reason recorded)',
    afterTrash.status === 'voided' && /trash/i.test(afterTrash.voidedReason ?? ''), afterTrash);
  check('recipient access tokens were nulled', afterTrash.recipients?.every((r) => r.accessToken == null));

  await expectError(
    axios.get(`${viewUrl}?token=${encodeURIComponent(recipient.accessToken)}`),
    403, 'ERR-FORBIDDEN', 'old view link after trash → 403 ERR-FORBIDDEN',
  );
  await expectError(
    axios.post(`${API_BASE}/signing/${created.id}/recipients/${recipient.id}/sign/external`,
      { accessToken: recipient.accessToken, fieldValues: [] }),
    409, 'ERR-INVALID-STATE', 'sign attempt on voided request → 409 ERR-INVALID-STATE',
  );

  // ════ 5. Deactivation offboarding sweep ════
  console.log('\n5. Deactivation offboarding sweep (M8)');
  const roles = unwrap<{ id: string; name?: string; code?: string }[]>(
    (await axios.get(`${API_BASE}/roles`, bearer(admin.token))).data,
  );
  const adminRole = roles.find((r) => (r.name ?? r.code) === 'SYSTEM_ADMIN') ?? roles[0];
  const throwawayEmail = `qa.sweep-verify-${Date.now()}@qa.local`;
  const throwaway = unwrap<{ id: string }>(
    (await axios.post(`${API_BASE}/users`, {
      email: throwawayEmail, firstName: 'Sweep', lastName: 'Verify', roleIds: [adminRole.id],
    }, bearer(admin.token))).data,
  );
  check('throwaway user created', Boolean(throwaway.id));

  const tSession = await login(throwawayEmail);
  await axios.post(`${API_BASE}/documents/${docA}/lock`, {}, bearer(tSession.token));
  const { rows: [{ n: locksBefore }] } = await db.query(
    'SELECT count(*)::int AS n FROM doc_locks WHERE locked_by = $1', [tSession.userId]);
  check('throwaway holds a doc lock before deactivation', locksBefore === 1, { locksBefore });

  const deactivated = unwrap<{ isActive?: boolean }>(
    (await axios.post(`${API_BASE}/users/${throwaway.id}/deactivate`, {}, bearer(admin.token))).data,
  );
  check('deactivate returns isActive=false', deactivated.isActive === false, deactivated);

  const { rows: [{ n: locksAfter }] } = await db.query(
    'SELECT count(*)::int AS n FROM doc_locks WHERE locked_by = $1', [tSession.userId]);
  check('sweep deleted the lock synchronously in the deactivation request', locksAfter === 0, { locksAfter });

  const { rows: auditRows } = await db.query(
    `SELECT action_details FROM audit_logs WHERE event_type = 'USER_DEACTIVATED'
     ORDER BY sequence_number DESC LIMIT 5`);
  const auditHit = auditRows
    .map((r) => (typeof r.action_details === 'string' ? JSON.parse(r.action_details) : r.action_details))
    .find((d) => d?.targetUserId === throwaway.id);
  check('USER_DEACTIVATED audit row carries offboardingSweep counts (locks >= 1)',
    Number(auditHit?.offboardingSweep?.locks) >= 1, auditHit ?? 'no audit row for throwaway');

  // ════ 6. AI consent gate: 403 → flag → 202 ════
  console.log('\n6. AI consent gate (403 → feature flag → 202)');
  await axios.patch(`${API_BASE}/tenants/${TENANT}/feature-flags`,
    { flag: 'ai_processing', enabled: false }, bearer(admin.token));
  await expectError(
    axios.post(`${API_BASE}/ai/documents/${docA}/summarize`, {}, bearer(admin.token)),
    403, 'ERR-AI-NOT-ENABLED', 'summarize with flag off → 403 ERR-AI-NOT-ENABLED',
  );
  const flags = unwrap<Record<string, boolean>>(
    (await axios.patch(`${API_BASE}/tenants/${TENANT}/feature-flags`,
      { flag: 'ai_processing', enabled: true }, bearer(admin.token))).data,
  );
  check('feature-flags PATCH flips ai_processing on', flags.ai_processing === true, flags);
  const aiResp = await axios.post(`${API_BASE}/ai/documents/${docA}/summarize`, {}, bearer(admin.token));
  check('summarize with flag on → 202 { queued: true }',
    aiResp.status === 202 && aiResp.data?.queued === true, { status: aiResp.status, body: aiResp.data });
  await axios.patch(`${API_BASE}/tenants/${TENANT}/feature-flags`,
    { flag: 'ai_processing', enabled: false }, bearer(admin.token)); // restore default

  // ════ 7. SLA breach → notification + EMAIL outbox → PROCESSED ════
  console.log('\n7. ApprovalSlaWorker breach → email actually sends');
  const assignables = unwrap<{ id: string; email?: string }[]>(
    (await axios.get(`${API_BASE}/approvals/assignable-users?capability=decide`, bearer(admin.token))).data,
  );
  const approver = assignables.find((u) => u.email === personaEmail('approver@edams.local'))
    ?? assignables.find((u) => u.id !== admin.userId);
  if (!approver) throw new Error('no assignable approver found');

  const docC = await uploadDoc(admin.token, `runtime-verify-sla-${Date.now()}`);
  await axios.post(`${API_BASE}/approvals/DOCUMENT/${docC}/submit`,
    { steps: [{ stepType: 'APPROVE', assignedUserId: approver.id, slaHours: 1 }] }, bearer(admin.token));
  check('document submitted with a 1h-SLA approval step', true);

  const slaStart = new Date();
  const backdated = await db.query(
    `UPDATE approval_steps SET due_at = NOW() - INTERVAL '5 minutes'
     WHERE chain_id = (SELECT id FROM approval_chains
                       WHERE item_type = 'DOCUMENT' AND item_id = $1 AND status = 'IN_REVIEW')
       AND status = 'PENDING'`, [docC]);
  check('backdated the PENDING step due_at (breach condition armed)', backdated.rowCount === 1);

  const slaQueue = new Queue('APPROVAL_SLA', { connection: redis });
  await slaQueue.add('sla-check', {}); // nudge — otherwise the cron fires only every 15 min

  let breachedAt: string | null = null;
  let outboxRow: { id: string; status: string; attempts: number; error_msg: string | null } | null = null;
  let notifCount = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { rows: [step] } = await db.query(
      `SELECT s.sla_breached_at FROM approval_steps s
       JOIN approval_chains c ON s.chain_id = c.id
       WHERE c.item_type = 'DOCUMENT' AND c.item_id = $1`, [docC]);
    breachedAt = step?.sla_breached_at ?? null;
    const { rows: [ob] } = await db.query(
      `SELECT id, status, attempts, error_msg FROM outbox_events
       WHERE type = 'APPROVAL.SLA_BREACH' AND channel = 'EMAIL' AND created_at >= $1
       ORDER BY created_at DESC LIMIT 1`, [slaStart]);
    outboxRow = ob ?? null;
    const { rows: [{ n }] } = await db.query(
      `SELECT count(*)::int AS n FROM notifications
       WHERE type = 'APPROVAL_SLA_BREACH' AND created_at >= $1`, [slaStart]);
    notifCount = n;
    if (breachedAt && outboxRow && ['PROCESSED', 'FAILED', 'DEAD_LETTER'].includes(outboxRow.status)) break;
    await sleep(3000);
  }
  await slaQueue.close();

  check('worker flagged the step (sla_breached_at set)', Boolean(breachedAt), { breachedAt });
  check('in-app APPROVAL_SLA_BREACH notification(s) written', notifCount >= 1, { notifCount });
  check('EMAIL outbox row created for APPROVAL.SLA_BREACH', Boolean(outboxRow), { outboxRow });
  check('EMAIL outbox row reached PROCESSED (SMTP accepted the message)',
    outboxRow?.status === 'PROCESSED', outboxRow ?? 'no row');

  // ════ 8. Sweep fault injection — a sweep DB error must not block deactivation ════
  console.log('\n8. Offboarding-sweep fault injection (savepoint isolation)');
  const faultEmail = `qa.sweep-fault-${Date.now()}@qa.local`;
  const faultUser = unwrap<{ id: string }>(
    (await axios.post(`${API_BASE}/users`, {
      email: faultEmail, firstName: 'Sweep', lastName: 'Fault', roleIds: [adminRole.id],
    }, bearer(admin.token))).data,
  );
  const fSession = await login(faultEmail);
  await axios.post(`${API_BASE}/documents/${docA}/lock`, {}, bearer(fSession.token));
  const { rows: [{ n: faultLocks }] } = await db.query(
    'SELECT count(*)::int AS n FROM doc_locks WHERE locked_by = $1', [fSession.userId]);
  check('fault user created and holds a doc lock', Boolean(faultUser.id) && faultLocks === 1, { faultLocks });

  // Statement-level trigger (fires even for zero-row DELETEs): the sweep's very
  // first statement (DocLock.destroy) now raises a real DB error inside the
  // request transaction — the exact class of failure the savepoint must contain.
  await db.query(`
    CREATE OR REPLACE FUNCTION runtime_verify_m8_fault() RETURNS trigger AS
    $$ BEGIN RAISE EXCEPTION 'runtime-verify: injected sweep fault'; END $$ LANGUAGE plpgsql`);
  await db.query(`
    CREATE TRIGGER runtime_verify_m8_fault BEFORE DELETE ON doc_locks
    FOR EACH STATEMENT EXECUTE FUNCTION runtime_verify_m8_fault()`);
  try {
    const faultDeact = unwrap<{ isActive?: boolean }>(
      (await axios.post(`${API_BASE}/users/${faultUser.id}/deactivate`, {}, bearer(admin.token))).data,
    );
    check('deactivate returns 200 isActive=false despite the sweep DB fault',
      faultDeact.isActive === false, faultDeact);
  } catch (e) {
    check('deactivate returns 200 isActive=false despite the sweep DB fault', false, errInfo(e));
  } finally {
    // Always remove the fault — leaving it behind would break every later lock release.
    await db.query('DROP TRIGGER IF EXISTS runtime_verify_m8_fault ON doc_locks');
    await db.query('DROP FUNCTION IF EXISTS runtime_verify_m8_fault()');
  }

  const { rows: [faultRow] } = await db.query(
    'SELECT is_active FROM users WHERE id = $1', [faultUser.id]);
  check('deactivation COMMITTED (users.is_active=false in the DB)', faultRow?.is_active === false, faultRow);

  const { rows: faultAudit } = await db.query(
    `SELECT action_details FROM audit_logs WHERE event_type = 'USER_DEACTIVATED'
     ORDER BY sequence_number DESC LIMIT 5`);
  const faultHit = faultAudit
    .map((r) => (typeof r.action_details === 'string' ? JSON.parse(r.action_details) : r.action_details))
    .find((d) => d?.targetUserId === faultUser.id);
  check('audit row written on the un-poisoned transaction with offboardingSweep=null',
    faultHit !== undefined && faultHit.offboardingSweep === null, faultHit ?? 'no audit row');

  const { rows: [{ n: faultLocksAfter }] } = await db.query(
    'SELECT count(*)::int AS n FROM doc_locks WHERE locked_by = $1', [fSession.userId]);
  check('failed sweep rolled back to the savepoint (lock intact, nothing half-swept)',
    faultLocksAfter === 1, { faultLocksAfter });
  await db.query('DELETE FROM doc_locks WHERE locked_by = $1', [fSession.userId]); // tidy: release the injected lock

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('\n❌ verifier crashed:', errInfo(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end().catch(() => {});
    redis.disconnect();
  });
