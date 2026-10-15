import { request, type APIRequestContext } from '@playwright/test';

/**
 * A thin API client for PROVISIONING, not for assertions.
 *
 * These specs assert on the UI; they use this only to put the system into the
 * state a test needs (an active form template, a draft letter) without spending
 * minutes clicking through setup screens that other specs already cover. The
 * behaviour under test is always driven through the browser.
 *
 * Anything a spec asserts about the DATABASE — "the chain really has these two
 * steps" — also comes back through here, because that is the half a UI
 * assertion cannot see: a picker can look perfect and still post nothing.
 */

const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:7100/api/v1';

/** Join a path onto the API base EXPLICITLY.
 *
 *  Playwright's `baseURL` is resolved with the URL constructor, so an absolute
 *  path like '/forms/templates' replaces the base's whole path and silently
 *  drops the '/api/v1' prefix — every call then hits the SPA fallback and comes
 *  back as HTML, surfacing as "Unexpected token '<'". */
const url = (path: string) => `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;

export type ApiSession = { ctx: APIRequestContext; token: string; user: any };

/** Log in over the API, completing the two-phase tenant selection. */
/** The person who approves what the fixtures create (a department head of HQ Finance in the QA tenant). */
export const APPROVER_EMAIL = 'qa.fin.head@qa.local';

export async function apiLogin(email = 'qa.sysadmin@qa.local'): Promise<ApiSession> {
  const ctx = await request.newContext();
  const login = await (await ctx.post(url('/auth/login'), { data: { email } })).json();

  let token: string = login.accessToken ?? login.token;
  let user = login.user;

  if (login.tenantSelectionRequired && login.preTenantToken) {
    const tenantId: string = login.availableTenants?.includes('qa-lab')
      ? 'qa-lab'
      : login.availableTenants?.[0];
    const selected = await (
      await ctx.post(url('/auth/select-tenant'), {
        data: { tenantId },
        headers: { Authorization: `Bearer ${login.preTenantToken}` },
      })
    ).json();
    token = selected.token ?? selected.accessToken;
    user = selected.user;
  }

  if (!token) throw new Error(`API login failed for ${email}: ${JSON.stringify(login)}`);
  return { ctx, token, user };
}

export const bearer = (s: ApiSession) => ({ Authorization: `Bearer ${s.token}` });

export async function apiGet<T = any>(s: ApiSession, path: string): Promise<T> {
  const res = await s.ctx.get(url(path), { headers: bearer(s) });
  if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Reference-data lookups, fetched once per run.
 *
 * The API caps a single user at RATE_LIMIT_USER_PER_MINUTE requests, and the
 * suite shares that budget with the BROWSER it is driving. Re-fetching the
 * department, org-unit, document-type and retention lists inside every helper
 * spent most of that budget on data that does not change during a run, and the
 * whole suite started failing with 429s the moment the specs ran together
 * rather than one at a time.
 *
 * Memoized by path, so this is also just what a real client does.
 */
const referenceCache = new Map<string, Promise<any>>();

export function apiGetCached<T = any>(s: ApiSession, path: string): Promise<T> {
  const existing = referenceCache.get(path);
  if (existing) return existing as Promise<T>;
  const pending = apiGet<T>(s, path);
  referenceCache.set(path, pending);
  // A failed lookup must not be cached, or one transient 429 poisons the run.
  pending.catch(() => referenceCache.delete(path));
  return pending;
}

export async function apiPost<T = any>(s: ApiSession, path: string, data: unknown): Promise<T> {
  const res = await s.ctx.post(url(path), { data, headers: bearer(s) });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** One text field on a blank A4 page — the smallest form template that renders. */
export const MINIMAL_FORM_SCHEMA = [
  [{ name: 'subject', type: 'text', title: 'Subject', position: { x: 20, y: 20 }, width: 170, height: 10, required: true }],
];

/**
 * Create a form template and ACTIVATE it.
 *
 * Activation goes through the approval engine on purpose — a direct status flip
 * to 'active' is refused (ERR-FORM-APPROVAL-REQUIRED), and the final APPROVE is
 * what sets the status. Reaching past that with a DB write would set up a state
 * the product cannot actually produce.
 */
export async function createActiveFormTemplate(
  s: ApiSession,
  opts: { name: string; instanceApproval: 'none' | 'chain' },
): Promise<any> {
  // The author cannot approve their own template (ERR-STEP-SELF-APPROVAL), so a second person decides it.
  const approver = await apiLogin(APPROVER_EMAIL);
  const created = (
    await apiPost(s, '/forms/templates', {
      name: opts.name,
      category: 'e2e',
      schemaJson: MINIMAL_FORM_SCHEMA,
      sectionsJson: [],
      instanceApproval: opts.instanceApproval,
    })
  ).data;

  const chain = await apiPost(s, `/approvals/FORM_TEMPLATE/${created.id}/submit`, {
    steps: [{ stepType: 'APPROVE', assignedUserId: approver.user.id }],
  });
  const step = chain.steps.find((x: any) => x.status === 'PENDING') ?? chain.steps[0];
  await apiPost(approver, `/approvals/chains/${chain.id}/steps/${step.id}/decision`, {
    decision: 'APPROVE',
    comment: 'e2e activation',
  });

  const activated = (await apiGet(s, `/forms/templates/${created.id}`)).data;
  if (activated.status !== 'active') {
    throw new Error(`form template ${created.id} did not activate (status=${activated.status})`);
  }
  return activated;
}

/** The newest form instance filed from a given template, with its chain. */
export async function latestFormInstanceChain(s: ApiSession, templateId: string) {
  const list = await apiGet(s, `/forms/instances?templateId=${templateId}&take=50`);
  const newest = (list.data ?? [])
    .slice()
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (!newest) return { instance: null, chain: null };
  const chain = await apiGet(s, `/approvals/FORM_INSTANCE/${newest.id}/chain`);
  return { instance: newest, chain };
}

/**
 * A minimal, structurally valid one-page PDF.
 *
 * Built as a literal rather than read from a fixture file so the suite carries
 * no binary asset. It only has to survive MIME sniffing, encryption and
 * storage — nothing here renders it.
 */
export const TINY_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n'),
  'latin1',
);

/**
 * Upload a DRAFT document.
 *
 * Provisioned rather than found, because "whatever draft happens to be in the
 * database" is not a fixture. The spec that needs one asserts on the submit
 * dialog's step editor, and it would silently SKIP on an environment with no
 * draft — which is exactly when a regression would ship unnoticed.
 */
export async function createDraftDocument(
  s: ApiSession,
  opts: { title: string; departmentCode?: string },
): Promise<any> {
  const departments = (await apiGetCached(s, '/departments')).data as Array<{ code: string }>;
  const docTypes = (await apiGetCached(s, '/document-types')).data as Array<{ code: string }>;
  const orgUnits = (await apiGetCached(s, '/org-units')).data as Array<{ name: string }>;
  // Retention class is validated against the tenant's registered policies
  // (ERR-RETENTION-INVALID), so it has to be read rather than assumed.
  const retention = (await apiGetCached(s, '/retention')).data as Array<{ retentionClass?: string; code?: string; name?: string }>;
  const retentionClass = retention?.[0]?.retentionClass ?? retention?.[0]?.code ?? retention?.[0]?.name;
  if (!retentionClass) throw new Error('no retention policy is registered — cannot upload a document');

  const res = await s.ctx.post(url('/documents'), {
    headers: bearer(s),
    multipart: {
      title: opts.title,
      departmentCode: opts.departmentCode ?? departments[0]!.code,
      documentTypeCode: (docTypes.find((t) => t.code === 'POLICY') ?? docTypes[0]!).code,
      organisationUnit: orgUnits[0]!.name,
      securityClassification: 'INTERNAL',
      retentionClass,
      source: 'MANUAL_UPLOAD',
      file: { name: 'e2e.pdf', mimeType: 'application/pdf', buffer: TINY_PDF },
    },
  });
  if (!res.ok()) throw new Error(`upload document -> ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return body.data ?? body;
}
