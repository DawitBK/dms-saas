/**
 * dev-admin.ts — one place that decides WHO a live verifier signs in as, and WHERE.
 *
 * The older verify-*.ts scripts used to hard-code `admin@edams.local` (a demo-seed account) and the demo tenant
 * `examplecorp`. The development database no longer has that account, and `examplecorp` there holds real collected
 * data, so the scripts now resolve both from here:
 *
 *   administrator  VERIFY_ADMIN_EMAIL   else  qa.sysadmin@qa.local   (the SYSTEM_ADMIN persona `npm run db:seed:qa` creates)
 *   tenant         VERIFY_TENANT        else  qa-lab                  (the practice tenant)
 *   API            API_URL              else  http://localhost:7100/api/v1
 *
 * Approval steps cannot go to their own author (ERR-SELF-APPROVAL / ERR-STEP-SELF-APPROVAL), so scripts that used to be
 * author and approver as the one demo administrator log a second person in (`verifyApproverEmail`, default
 * qa.fin.approver@qa.local). The demo seed's role accounts (manager@, ops.manager@, ... @edams.local) are translated to their
 * QA equivalents by `DEMO_TO_QA_PERSONA`, so the scripts keep their original names for them.
 *
 * Exit codes: 2 = refused (not a local dev target), 3 = needs data or sign-in this database does not have, 1 = a check failed.
 *
 * Sign-in is the dev passwordless `POST /auth/login {email}` (needs LOCAL_JWT_MOCK=true in the dev env file, which
 * should be switched back afterwards). DMS has no password login (production is SSO only), so there is no
 * password variable and no account is created here.
 *
 * Safety: every entry point calls `assertLocalDevTarget()`, which refuses (exit 2) when NODE_ENV is production or
 * mirror, when the API host is not localhost / 127.0.0.1 / ::1, or when the port is in the mirror/production ranges
 * (9xxx, 8090, 80, 443). It cannot be pointed at a real system by an environment variable.
 *
 * Data the practice workspace does not have (the demo personas, a demo organisation structure, document types such as
 * REPORT) is NOT invented: a script that needs it calls `needsDemoData()`, which prints one line and exits 3.
 */
import axios from 'axios';

export const DEFAULT_API = 'http://localhost:7100/api/v1';
export const DEFAULT_ADMIN_EMAIL = 'qa.sysadmin@qa.local';
export const DEFAULT_TENANT = 'qa-lab';

export function apiBase(): string {
  return (process.env.API_URL || DEFAULT_API).replace(/\/+$/, '');
}
export function verifyAdminEmail(): string {
  return process.env.VERIFY_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
}
export function verifyTenantId(): string {
  return process.env.VERIFY_TENANT || DEFAULT_TENANT;
}
/**
 * A second person to decide approval steps. The product refuses self-approval (ERR-SELF-APPROVAL for letters,
 * ERR-STEP-SELF-APPROVAL for chains), so a verifier that used to be both author and approver as the one demo
 * administrator now needs someone else. VERIFY_APPROVER_EMAIL, else the QA world's APPROVER in Finance.
 */
export const DEFAULT_APPROVER_EMAIL = 'qa.fin.approver@qa.local';
export function verifyApproverEmail(): string {
  return process.env.VERIFY_APPROVER_EMAIL || DEFAULT_APPROVER_EMAIL;
}

function refuse(why: string): never {
  console.error(`Refusing: ${why} These verifiers run only against the local development backend.`);
  process.exit(2);
}

/** Exit 2 unless the target is the local development backend. Safe to call repeatedly. */
export function assertLocalDevTarget(base: string = apiBase()): void {
  const env = process.env.NODE_ENV;
  if (env === 'production' || env === 'mirror') refuse(`NODE_ENV=${env}.`);
  let url: URL;
  try { url = new URL(base); } catch { return refuse(`API_URL "${base}" is not a URL.`); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) refuse(`API host "${url.hostname}" is not localhost.`);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if ((port >= 9000 && port <= 9999) || port === 8090 || port === 80 || port === 443) {
    refuse(`API port ${port} is a mirror/production port, not the development backend (7100).`);
  }
  if (process.env.DB_NAME && process.env.DB_NAME !== 'DMS' && /prod|mirror/i.test(process.env.DB_NAME)) {
    refuse(`DB_NAME=${process.env.DB_NAME} looks like a mirror/production database.`);
  }
}

/** For the scripts that talk to the database directly: refuse anything but a local database. */
export function assertLocalDevDatabase(host: string | undefined, database: string | undefined): void {
  assertLocalDevTarget();
  if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) refuse(`database host "${host}" is not local.`);
  if (database && /prod|mirror/i.test(database)) refuse(`database "${database}" looks like a mirror/production database.`);
}

/** A script needs data the practice workspace does not have. One line, exit 3 (distinct from a failed check). */
export function needsDemoData(script: string, what: string): never {
  console.error(`NEEDS DEMO DATA: ${script} cannot run on this database: ${what}. (The demo seed, \`npm run db:seed:core\`, creates it; it is not run on a database that holds real data.)`);
  process.exit(3);
}

/**
 * The demo seed's role personas, mapped to the QA world's equivalent (same role, same department code). The scripts
 * keep their original `ops.manager@edams.local` style names; they are translated here so no demo account is needed.
 * A persona with no QA equivalent is not listed, and signing in as it ends in `needsDemoData`.
 */
export const DEMO_TO_QA_PERSONA: Record<string, string> = {
  'manager@edams.local': 'qa.fin.head@qa.local', // DEPT_MANAGER, FIN
  'ops.manager@edams.local': 'qa.ops.head@qa.local', // DEPT_MANAGER, OPS
  'hr.manager@edams.local': 'qa.hr.head@qa.local', // DEPT_MANAGER, HR
  'employee@edams.local': 'qa.fin.staff1@qa.local', // EMPLOYEE, FIN
  'approver@edams.local': 'qa.fin.approver@qa.local', // APPROVER, FIN
  'officer@edams.local': 'qa.records@qa.local', // RECORDS_OFFICER (any account that can switch MFA on and off will do)
};

/** The QA-world account to use for a demo persona name (returns the input unchanged when it has no mapping). */
export function personaEmail(requested: string): string {
  return DEMO_TO_QA_PERSONA[requested] ?? requested;
}

/**
 * An account that belongs to TWO OR MORE tenants (for the tenant-selection and tenant-switch checks). The practice
 * workspace has none and none is invented: set VERIFY_MULTITENANT_EMAIL to one if the database has it.
 */
export function verifyMultiTenantEmail(): string | undefined {
  return process.env.VERIFY_MULTITENANT_EMAIL || undefined;
}

export type VerifyLogin = { token: string; user: { id: string; email?: string; [k: string]: unknown }; userId: string; tenantId: string };

/** Passwordless dev sign-in, then tenant selection when the account has more than one tenant. */
export async function loginAs(requested: string, script = 'this script'): Promise<VerifyLogin> {
  assertLocalDevTarget();
  const email = personaEmail(requested);
  const base = apiBase();
  const tenant = verifyTenantId();
  let r: { data: Record<string, any> };
  try {
    r = await axios.post(`${base}/auth/login`, { email });
  } catch (e) {
    const resp = (e as { response?: { status?: number; data?: { error?: { code?: string }; code?: string } } }).response;
    const code = resp?.data?.error?.code ?? resp?.data?.code ?? '';
    if (code === 'ERR-MOCK-DISABLED') {
      console.error('Cannot sign in: LOCAL_JWT_MOCK is not enabled on the dev backend (set it in backend/.env.development, restart, and switch it back afterwards).');
      process.exit(3);
    }
    if (resp?.status === 401) needsDemoData(script, `no active account "${email}" on this database (set VERIFY_ADMIN_EMAIL to an administrator that exists)`);
    if (!resp) { console.error(`Cannot reach the dev backend at ${base}: ${(e as Error).message}`); process.exit(3); }
    throw e;
  }
  const d = r.data.data && !r.data.accessToken && !r.data.tenantSelectionRequired ? r.data.data : r.data;
  if (d.tenantSelectionRequired) {
    const available: string[] = d.availableTenants ?? [];
    if (!available.includes(tenant)) {
      needsDemoData(script, `"${email}" is not a member of tenant "${tenant}" (it has: ${available.join(', ') || 'none'}); set VERIFY_TENANT`);
    }
    const s = (await axios.post(`${base}/auth/select-tenant`, { tenantId: tenant }, { headers: { Authorization: `Bearer ${d.preTenantToken}` } })).data;
    const sd = s.data && !s.accessToken && !s.token ? s.data : s;
    return { token: sd.accessToken ?? sd.token, user: sd.user ?? d.user, userId: (sd.user ?? d.user).id, tenantId: tenant };
  }
  return { token: d.accessToken ?? d.token, user: d.user, userId: d.user.id, tenantId: d.user?.tenantId ?? tenant };
}

/** Sign in as the verification administrator (see the header for how it is resolved). */
export function loginAsAdmin(script = 'this script'): Promise<VerifyLogin> {
  return loginAs(verifyAdminEmail(), script);
}

/** Sign in as another named persona; exits 3 with a one-line message when that account does not exist here. */
export function loginAsPersona(email: string, script = 'this script'): Promise<VerifyLogin> {
  return loginAs(email, script);
}
