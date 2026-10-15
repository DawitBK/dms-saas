/**
 * RLS rehearsal — the two Session-22 loose ends, driven against the edams_app
 * API instance on :14100 (DB dms_rls_rehearsal, Redis db 1):
 *   A. tus resumable upload end-to-end under RLS (create + patch + finish →
 *      documents/acl/outbox rows land in the right tenant).
 *   B. outbox dispatcher scoping under RLS: DOCUMENT.CREATED (payload now
 *      stamped with tenantId at enqueue) fans out to a WEBHOOK row whose
 *      subscriber lookup runs under withWorkerTenantContext — the row must
 *      reach PROCESSED with the local sink receiving the signed delivery.
 *   C. negative control: bare (GUC-less) documents SELECT as edams_app is 0.
 */
import axios from 'axios';
import pg from 'pg';
import { assertLocalDevTarget } from './lib/dev-admin.js';

const API = 'http://localhost:14100/api/v1';
// This one does NOT run against the dev backend (:7100): it needs its own rehearsal stack (API on :14100 as edams_app,
// scratch database dms_rls_rehearsal). That scratch database is a copy that carries the demo seed, so its administrator is
// still admin@edams.local; VERIFY_ADMIN_EMAIL overrides it. The local-target guard applies as everywhere else.
const ADMIN_EMAIL = process.env.VERIFY_ADMIN_EMAIL || 'admin@edams.local';
const TENANT = 'examplecorp';
const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name: string, ok: boolean, details?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, details !== undefined ? JSON.stringify(details) : ''); }
}

const superDb = new pg.Client({
  host: 'localhost', port: 5432, user: 'postgres', password: 'change-me-dev-password', database: 'dms_rls_rehearsal',
});
const appDb = new pg.Client({
  host: 'localhost', port: 5432, user: 'edams_app', password: 'edams_app_change_me_before_use', database: 'dms_rls_rehearsal',
});

async function login(email: string) {
  assertLocalDevTarget(API);
  const r = (await axios.post(`${API}/auth/login`, { email })).data;
  if (r.tenantSelectionRequired) {
    const s = (await axios.post(`${API}/auth/select-tenant`, { tenantId: TENANT }, bearer(r.preTenantToken))).data;
    return { token: s.accessToken ?? s.token, userId: r.user.id };
  }
  return { token: r.accessToken ?? r.token, userId: r.user.id };
}

async function main() {
  try {
    await superDb.connect();
    await appDb.connect();
  } catch (err: any) {
    console.log(`  ℹ RLS rehearsal database not available (${err?.message}) — skipping rehearsal verification`);
    process.exit(0);
  }

  let admin: any;
  try {
    admin = await login(ADMIN_EMAIL);
  } catch (err: any) {
    console.log(`  ℹ RLS rehearsal API on :14100 not available (${err?.message}) — skipping rehearsal verification`);
    process.exit(0);
  }

  console.log('\nA. webhook subscription + tus upload under edams_app');

  const sub = (await axios.post(`${API}/webhooks`,
    { url: 'http://localhost:19999/hook', secret: 'rls-rehearsal-secret' }, bearer(admin.token))).data;
  check('webhook subscription registered (loopback allowed in dev)', Boolean(sub.id), sub);

  // ── tus create ──
  const title = `rls-tus-${Date.now()}`;
  const content = Buffer.from(`tus-under-rls: ${title}`);
  const meta: Record<string, string> = {
    title, departmentCode: 'FIN', documentTypeCode: 'REPORT', organisationUnit: 'HQ',
    securityClassification: 'INTERNAL', retentionClass: 'RET-FIN-7Y', source: 'API',
    filename: `${title}.txt`,
  };
  const uploadMetadata = Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',');

  const created = await axios.post(`${API}/documents/upload/tus`, null, {
    headers: {
      ...bearer(admin.token).headers,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(content.length),
      'Upload-Metadata': uploadMetadata,
    },
    maxRedirects: 0,
    validateStatus: (s) => s === 201,
  });
  const location = created.headers['location'] as string;
  check('tus create returned 201 + Location', Boolean(location), created.headers);

  const uploadUrl = location.startsWith('http') ? location : `http://localhost:14100${location}`;
  const patch = await axios.patch(uploadUrl, content, {
    headers: {
      ...bearer(admin.token).headers,
      'Tus-Resumable': '1.0.0',
      'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream',
    },
    validateStatus: () => true,
  });
  check('tus patch completed (2xx, full offset)', patch.status >= 200 && patch.status < 300
    && Number(patch.headers['upload-offset']) === content.length,
    { status: patch.status, offset: patch.headers['upload-offset'], body: patch.data });

  // ── server-side effects, checked as superuser ──
  const { rows: [doc] } = await superDb.query(
    `SELECT id, tenant_id, status FROM documents WHERE title = $1`, [title]);
  check('documents row exists with correct tenant (INSERT passed RLS WITH CHECK)',
    doc?.tenant_id === TENANT, doc ?? 'no row');
  if (!doc) throw new Error('no document row — cannot continue');

  const { rows: [{ n: aclCount }] } = await superDb.query(
    `SELECT count(*)::int AS n FROM acl_entries WHERE resource_id = $1::uuid AND tenant_id = $2`,
    [doc.id, TENANT]);
  check('default ACL rows written under RLS', aclCount >= 1, { aclCount });

  const { rows: [createdEvt] } = await superDb.query(
    `SELECT id, payload FROM outbox_events WHERE type = 'DOCUMENT.CREATED' AND document_id = $1
     ORDER BY created_at DESC LIMIT 1`, [doc.id]);
  const payload = createdEvt ? JSON.parse(createdEvt.payload) : null;
  check('DOCUMENT.CREATED outbox payload carries tenantId (S22 enqueue-site fix)',
    payload?.tenantId === TENANT, payload);

  console.log('\nB. webhook fan-out + delivery under edams_app');
  let webhookRow: { id: string; status: string; error_msg: string | null } | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { rows: [wh] } = await superDb.query(
      `SELECT id, status, error_msg FROM outbox_events
       WHERE channel = 'WEBHOOK' AND source_event_id = $1`, [createdEvt.id]);
    webhookRow = wh ?? null;
    if (webhookRow && ['PROCESSED', 'FAILED', 'DEAD_LETTER'].includes(webhookRow.status)) break;
    await sleep(2000);
  }
  check('WEBHOOK fan-out row spawned from DOCUMENT.CREATED', Boolean(webhookRow), 'no row after 60s');
  check('WEBHOOK row PROCESSED — subscriber lookup found the tenant row under RLS',
    webhookRow?.status === 'PROCESSED', webhookRow ?? 'none');

  console.log('\nC. negative control — bare edams_app connection sees zero documents');
  const { rows: [{ n: bare }] } = await appDb.query('SELECT count(*)::int AS n FROM documents');
  check('GUC-less SELECT on documents returns 0 rows (strict policy live)', bare === 0, { bare });
  await appDb.query('BEGIN');
  await appDb.query(`SET LOCAL app.current_tenant = '${TENANT}'`);
  const { rows: [{ n: scoped }] } = await appDb.query('SELECT count(*)::int AS n FROM documents');
  await appDb.query('ROLLBACK');
  check('same connection with the tenant GUC sees the rows', scoped >= 1, { scoped });

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    const r = (e as { response?: { status?: number; data?: unknown } })?.response;
    console.error('crashed:', r ? { status: r.status, body: r.data } : (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await superDb.end().catch(() => {});
    await appDb.end().catch(() => {});
  });
