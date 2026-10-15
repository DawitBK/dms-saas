/**
 * Live verification that the platform administrator is invisible and untouchable.
 * Run (API on :7100, dev DB):  npx tsx test-scripts/verify-platform-admin.ts
 *
 * Acts as an ordinary SYSTEM_ADMIN (a throwaway account this script creates and
 * removes itself, so it does not depend on any seeded demo user)
 * and tries to find, read, change and remove every platform admin in the
 * database — expecting "user not found" every time, and the database to be
 * unchanged. Then logs in AS a platform admin and checks that it sees itself,
 * that its own activity is recorded without any identifying field, and that the
 * hash chain still verifies. Every hostile request is one that could do harm if
 * the guard failed, so the database triggers are the second line of defence for
 * the destructive ones.
 *
 * Signs in by MINTING the session token directly with the server's own session key
 * (the same kid 'dev-key' / DEV_RSA_PRIVATE_KEY every real login ends with), not through
 * the passwordless /auth/login. So it does not need LOCAL_JWT_MOCK at all, and passing proves
 * the API accepts DMS's own sessions with the mock OFF, which is how production now runs.
 * (The platform-admin half is checked against the live database, so the API must be up on
 * :7100 against the same database this script reads.)
 */
import '../src/config/env.js';
import axios, { AxiosError } from 'axios';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config/env.js';
import { initModels } from '../src/infrastructure/database/models/index.js';
import { writeAuditLog } from '../src/modules/audit/audit.service.js';
import { resolveUnionPermissions } from '../src/modules/roles/roles.service.js';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/infrastructure/database/sequelize.js';

const API = process.env.API_URL || 'http://localhost:7100/api/v1';
const ADMIN_EMAIL = 'verify-admin@verify.invalid';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

/** Mint a session exactly as the OIDC callback / loginMock do: RS256, keyid 'dev-key', the DMS session key. */
async function login(email: string): Promise<{ token: string; userId: string }> {
  const rows = await sequelize.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, { bind: [email], type: QueryTypes.SELECT });
  if (rows.length === 0) throw new Error(`no such user ${email}`);
  const userId = rows[0].id;
  const roleNames = (await sequelize.query<{ name: string }>(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.name`,
    { bind: [userId], type: QueryTypes.SELECT },
  )).map((r) => r.name);
  const tenants = (await sequelize.query<{ tenant_id: string }>(`SELECT tenant_id FROM user_tenants WHERE user_id = $1`, { bind: [userId], type: QueryTypes.SELECT })).map((t) => t.tenant_id);
  const tenantId = tenants.includes('examplecorp') ? 'examplecorp' : tenants[0];
  // A user with several roles signs in as ONE (the role-selection step); pick the strongest the test needs.
  const role = roleNames.includes('PLATFORM_ADMIN') ? 'PLATFORM_ADMIN' : roleNames.includes('SYSTEM_ADMIN') ? 'SYSTEM_ADMIN' : roleNames[0];
  const permissions = await resolveUnionPermissions([role], tenantId, userId);
  if (!config.DEV_RSA_PRIVATE_KEY) throw new Error('DEV_RSA_PRIVATE_KEY is not configured');
  const key = Buffer.from(config.DEV_RSA_PRIVATE_KEY, 'base64').toString('utf-8');
  const token = jwt.sign(
    {
      jti: randomUUID(), user_id: userId, roles: [role], role, permissions, tenant_id: tenantId,
      iss: config.DEV_JWT_ISSUER ?? config.AUTH_ISSUER ?? 'http://localhost:7300',
      aud: config.DEV_JWT_AUDIENCE ?? config.AUTH_AUDIENCE ?? 'edams-api',
    },
    key,
    { algorithm: 'RS256', keyid: 'dev-key', expiresIn: '10m' },
  );
  return { token, userId };
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  try {
    const r = await axios.request({ method: method as any, url: `${API}${path}`, data: body, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    return { status: r.status, data: r.data };
  } catch (e) {
    const err = e as AxiosError;
    return { status: err.response?.status ?? 0, data: err.response?.data };
  }
}

const idsIn = (json: unknown): string[] => JSON.stringify(json).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];

/** A throwaway SYSTEM_ADMIN in the real tenant, so the check needs no seeded demo account. */
async function createVerifyAdmin(): Promise<void> {
  await removeVerifyAdmin();
  const u = await sequelize.query<{ id: string }>(
    `INSERT INTO users (email, first_name, last_name, is_active) VALUES ($1, 'Verify', 'Admin', true) RETURNING id`,
    { bind: [ADMIN_EMAIL], type: QueryTypes.SELECT },
  );
  const role = await sequelize.query<{ id: string }>(`SELECT id FROM roles WHERE name = 'SYSTEM_ADMIN'`, { type: QueryTypes.SELECT });
  await sequelize.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, { bind: [u[0].id, role[0].id] });
  await sequelize.query(`INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, 'examplecorp')`, { bind: [u[0].id] });
}

async function removeVerifyAdmin(): Promise<void> {
  const ids = await sequelize.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, { bind: [ADMIN_EMAIL], type: QueryTypes.SELECT });
  for (const { id } of ids) {
    await sequelize.query(`DELETE FROM user_session_cutoffs WHERE user_id = $1`, { bind: [id] });
    await sequelize.query(`DELETE FROM user_roles WHERE user_id = $1`, { bind: [id] });
    await sequelize.query(`DELETE FROM user_tenants WHERE user_id = $1`, { bind: [id] });
    await sequelize.query(`DELETE FROM users WHERE id = $1`, { bind: [id] });
  }
}

async function main() {
  await sequelize.authenticate();
  initModels();
  const started = new Date();
  await createVerifyAdmin();

  const pas = await sequelize.query<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.name = 'PLATFORM_ADMIN'`,
    { type: QueryTypes.SELECT },
  );
  if (pas.length === 0) { console.log('No platform admin in this database; nothing to verify.'); process.exit(0); }
  const paIds = pas.map((p) => p.id);
  const paRole = (await sequelize.query<{ id: string }>(`SELECT id FROM roles WHERE name='PLATFORM_ADMIN'`, { type: QueryTypes.SELECT }))[0].id;
  const empRole = (await sequelize.query<{ id: string }>(`SELECT id FROM roles WHERE name='EMPLOYEE'`, { type: QueryTypes.SELECT }))[0].id;
  console.log(`${pas.length} platform admin(s) in the database; acting as ${ADMIN_EMAIL}\n`);

  let admin: { token: string; userId: string };
  try {
    admin = await login(ADMIN_EMAIL);
  } catch (e) {
    console.log(`Could not sign in as ${ADMIN_EMAIL} (is the API running against this database?): ${(e as Error).message}`);
    process.exit(2);
  }
  const t = admin.token;
  // The chain may carry known historical breaks (an old one at seq 476 predates all of this work).
  // What must hold is that nothing in THIS run adds one, so take a baseline now.
  const baselineIntegrity = await call(t, 'GET', '/audit/verify-integrity');
  const baselineBreaks = JSON.stringify((baselineIntegrity.data?.breaks ?? []).map((b: any) => b.sequenceNumber ?? b.sequence ?? b));
  const before = await sequelize.query<any>(`SELECT id, email, is_active, deleted_at FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`, { bind: [paIds], type: QueryTypes.SELECT });

  console.log('lists and pickers never contain a platform admin');
  const users = await call(t, 'GET', '/users');
  check('GET /users answers 200', users.status === 200, `(${users.status})`);
  check('GET /users has no platform admin id', !idsIn(users.data).some((i) => paIds.includes(i)));
  check('GET /users has no platform admin email', !pas.some((p) => JSON.stringify(users.data).includes(p.email)));
  const roles = await call(t, 'GET', '/roles');
  check('GET /roles does not offer PLATFORM_ADMIN', !JSON.stringify(roles.data).includes('PLATFORM_ADMIN'));
  const advisory = await call(t, 'GET', '/assignment-advisory/roles');
  check('role picker (assignment advisory) does not offer PLATFORM_ADMIN', !JSON.stringify(advisory.data).includes('PLATFORM_ADMIN'));
  for (const path of ['/approvals/assignable-users', '/letters/assignable-users?stepType=SIGNATORY', '/signing/assignable-users']) {
    const r = await call(t, 'GET', path);
    check(`${path} has no platform admin`, r.status === 200 && !idsIn(r.data).some((i) => paIds.includes(i)), `(${r.status})`);
  }
  const members = await call(t, 'GET', '/tenants/examplecorp/members');
  check('tenant members has no platform admin', members.status !== 200 || !idsIn(members.data).some((i) => paIds.includes(i)), `(${members.status})`);
  const audit = await call(t, 'GET', '/audit?take=100');
  check('audit list has no row by a platform admin', audit.status !== 200 || !(audit.data.data ?? []).some((r: any) => paIds.includes(r.userId)));

  console.log('\na request that names a platform admin reads as "user not found"');
  for (const pa of paIds) {
    const short = pa.slice(0, 8);
    for (const [method, path, body] of [
      ['GET', `/users/${pa}`, undefined],
      ['GET', `/users/${pa}/activity`, undefined],
      ['PATCH', `/users/${pa}`, {}],
      ['DELETE', `/users/${pa}`, undefined],
      ['POST', `/users/${pa}/deactivate`, undefined],
      ['POST', `/users/${pa}/activate`, undefined],
      ['POST', `/users/${pa}/force-logout`, undefined],
      ['POST', `/users/${pa}/roles`, { roleId: empRole }],
      ['DELETE', `/users/${pa}/roles/${empRole}`, undefined],
      ['GET', `/users/${pa}/permission-overrides`, undefined],
      ['PUT', `/users/${pa}/permission-overrides`, { grants: [], revokes: [] }],
    ] as [string, string, unknown][]) {
      const r = await call(t, method, path, body);
      check(`${method} ${path.replace(pa, short + '…')} -> 404`, r.status === 404, `(got ${r.status})`);
    }
  }
  const missing = await call(t, 'GET', '/users/00000000-0000-0000-0000-00000000dead');
  const hidden = await call(t, 'GET', `/users/${paIds[0]}`);
  check('hidden user and nonexistent user give the identical answer', missing.status === hidden.status && JSON.stringify(missing.data) === JSON.stringify(hidden.data));

  console.log('\nthe role cannot be selected, read or edited');
  const permsGet = await call(t, 'GET', `/roles/${paRole}/permissions`);
  check('GET role permissions -> 404', permsGet.status === 404, `(${permsGet.status})`);
  const permsPut = await call(t, 'PUT', `/roles/${paRole}/permissions`, { permissions: [] });
  check('PUT role permissions -> 404', permsPut.status === 404, `(${permsPut.status})`);
  const grantAttempt = await call(t, 'POST', `/users/${admin.userId}/roles`, { roleId: paRole });
  check('cannot grant the role to anyone', grantAttempt.status === 404, `(${grantAttempt.status})`);
  const reserved = await call(t, 'PUT', `/users/${admin.userId}/permission-overrides`, { grants: ['platform:admin'], revokes: [] });
  check('cannot hand out the platform:admin permission', reserved.status >= 400, `(${reserved.status})`);

  console.log('\ndatabase unchanged by all of the above');
  const after = await sequelize.query<any>(`SELECT id, email, is_active, deleted_at FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`, { bind: [paIds], type: QueryTypes.SELECT });
  check('platform admin rows identical', JSON.stringify(before) === JSON.stringify(after));
  const stillHold = await sequelize.query<{ n: string }>(`SELECT count(*)::text n FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.name='PLATFORM_ADMIN'`, { type: QueryTypes.SELECT });
  check('platform admin role holders unchanged', Number(stillHold[0].n) === pas.length);

  console.log('\nthe platform admin itself');
  const paLogin = await login(pas[0].email);
  const me = await call(paLogin.token, 'GET', '/users/me');
  check('sees its own profile', me.status === 200 && me.data?.id === pas[0].id, `(${me.status})`);
  const self = await call(paLogin.token, 'GET', `/users/${pas[0].id}`);
  check('can read its own record', self.status === 200, `(${self.status})`);
  if (paIds.length > 1) {
    const other = await call(paLogin.token, 'GET', `/users/${paIds[1]}`);
    check('cannot see ANOTHER platform admin', other.status === 404, `(${other.status})`);
  }
  const paRoles = await call(paLogin.token, 'GET', '/roles');
  check('does not see the role in the role list either', !JSON.stringify(paRoles.data).includes('PLATFORM_ADMIN'));

  console.log('\nthe audit trail');
  await call(paLogin.token, 'GET', '/users'); // some activity
  // An action by the platform admin, written the way every service writes one (userId = the actor).
  await writeAuditLog({ eventType: 'AUTH_LOGIN' as never, userId: pas[0].id, userRole: 'PLATFORM_ADMIN', tenantId: 'examplecorp', sourceIp: '203.0.113.9', sessionId: 'sess-x', actionDetails: { note: 'verify-platform-admin' } });
  const rows = await sequelize.query<{ n: string }>(
    `SELECT count(*)::text n FROM audit_logs WHERE user_id = ANY($1::uuid[]) AND "timestamp" >= $2`,
    { bind: [paIds, started], type: QueryTypes.SELECT },
  );
  check('no audit row attributed to a platform admin since this run began', Number(rows[0].n) === 0, `(${rows[0].n})`);
  const masked = await sequelize.query<any>(
    `SELECT user_id, user_role, source_ip, session_id FROM audit_logs WHERE event_type = 'AUTH_LOGIN' AND "timestamp" >= $1 AND action_details LIKE '%verify-platform-admin%' ORDER BY sequence_number DESC LIMIT 1`,
    { bind: [started], type: QueryTypes.SELECT },
  );
  check('the platform admin action was still recorded', masked.length === 1, `(${masked.length})`);
  check('but with no actor, role, address or session', masked[0]?.user_id === null && masked[0]?.user_role === null && masked[0]?.source_ip === null && masked[0]?.session_id === null, JSON.stringify(masked[0]));
  const integrity = await call(t, 'GET', '/audit/verify-integrity');
  const nowBreaks = JSON.stringify((integrity.data?.breaks ?? []).map((b: any) => b.sequenceNumber ?? b.sequence ?? b));
  check('audit hash chain gained no new break (anonymised rows chain correctly)', integrity.status === 200 && nowBreaks === baselineBreaks, `(was ${baselineBreaks}, now ${nowBreaks})`);

  await removeVerifyAdmin();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await removeVerifyAdmin(); } catch { /* ignore */ } process.exit(1); });
