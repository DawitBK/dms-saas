import { test, expect, signIn, expectPageHealthy, watchConsole } from './fixtures/app';
import { apiLogin, apiGet, TINY_PDF } from './fixtures/api';
import type { Browser, Page } from '@playwright/test';
import path from 'node:path';

/**
 * The QA tenant ("qa-lab", built by backend `npm run db:seed:qa`) walked as the people who use it.
 *
 * Three questions, asked for many different personas rather than one admin:
 *   1. Does every screen they can reach actually mount, with no crash and no console error?
 *   2. Does the Documents list show exactly the documents the access rules say they can read —
 *      and nothing a DENY, a folder closure, an expired grant or another department should hide?
 *   3. Do the real clicks work: approving from My Work, browsing folders, the Operations tabs?
 *
 * Screenshots of every persona/screen land in e2e/qa-shots/ (gitignored) so a person can look at what
 * each role actually sees.
 */

const SHOTS = path.join(__dirname, 'qa-shots');
const email = (key: string) => `qa.${key}@qa.local`;

async function asPersona(browser: Browser, key: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, email(key));
  return page;
}

/** Failed API calls per screen: a 4xx/5xx the page triggers on its own is a bug (the screen asked for something its user may not have). */
function trackFailures(page: Page) {
  const state = { route: '', failures: [] as string[] };
  page.on('response', (r) => {
    const status = r.status();
    if (status < 400 || /favicon|.map$/.test(r.url())) return;
    state.failures.push(`${state.route} → ${status} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
  });
  return state;
}
/** console noise that only repeats a failed request, already reported by trackFailures */
const notRequestNoise = (errors: string[]) => errors.filter((e) => !/Failed to load resource/i.test(e));

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }).catch(() => {});
}

// ───────────────────────── 1. every screen mounts, for several kinds of people ─────────────────────────

const DASHBOARD_ROUTES = [
  '/dashboard', '/dashboard/documents', '/dashboard/browse', '/dashboard/files', '/dashboard/upload', '/dashboard/search',
  '/dashboard/mywork', '/dashboard/notifications', '/dashboard/trash', '/dashboard/bundles', '/dashboard/reports', '/dashboard/storage',
  '/dashboard/letters', '/dashboard/letters/register', '/dashboard/letters/new',
  '/dashboard/forms', '/dashboard/forms/templates', '/dashboard/forms/fill', '/dashboard/forms/submissions',
  '/dashboard/signing', '/dashboard/signing/overview', '/dashboard/signing/pending', '/dashboard/signing/sent', '/dashboard/signing/completed',
  '/dashboard/ai', '/settings',
];

const PANELS = [
  'manager', 'reports', 'audit', 'integrity', 'users', 'roles', 'accessControl', 'tenants', 'orgUnits', 'departments', 'hierarchy', 'folders',
  'docTypes', 'workflows', 'workflowDefs', 'approvalChains', 'workflowInstances', 'aiControls', 'idpRoleMappings', 'lifecycle',
  'retentionPolicies', 'legalHold', 'ocr', 'health', 'pipeline', 'systemErrors', 'outbox', 'webhooks',
];

const PERSONAS_FOR_ROUTES = ['sysadmin', 'fin.head', 'fin.staff1', 'hr.staff', 'auditor', 'exec', 'records', 'no.dept', 'north.staff', 'eng.head'];

test.describe('every dashboard screen mounts for every kind of person', () => {
  for (const key of PERSONAS_FOR_ROUTES) {
    test(`${key}: all dashboard routes`, async ({ browser }) => {
      const page = await asPersona(browser, key);
      const watcher = watchConsole(page);
      const http = trackFailures(page);
      const problems: string[] = [];
      for (const route of DASHBOARD_ROUTES) {
        http.route = route;
        await page.goto(route);
        await page.waitForLoadState('domcontentloaded');
        if (/\/login/.test(page.url())) { problems.push(`${route}: bounced to login`); continue; }
        const crashed = await page.locator('text=/Unhandled Runtime Error|Application error: a client-side exception|Internal Server Error/i').count();
        if (crashed) problems.push(`${route}: crash screen`);
        const empty = (await page.locator('body').innerText()).trim().length < 20;
        if (empty) problems.push(`${route}: empty page`);
        await page.waitForTimeout(250);
        if (route === '/dashboard' || route === '/dashboard/documents' || route === '/dashboard/browse') await shot(page, `${key}-${route.replace(/\W+/g, '_')}`);
      }
      expect(problems, problems.join('\n')).toEqual([]);
      expect(http.failures, http.failures.join('\n')).toEqual([]);
      expect(notRequestNoise(watcher.errors), watcher.errors.join('\n')).toEqual([]);
      await page.context().close();
    });
  }
});

test.describe('every Operations tab mounts', () => {
  for (const key of ['sysadmin', 'fin.head', 'auditor', 'records', 'exec', 'fin.staff1', 'hr.head', 'fin.approver']) {
    test(`${key}: all operations panels`, async ({ browser }) => {
      const page = await asPersona(browser, key);
      const watcher = watchConsole(page);
      const http = trackFailures(page);
      const problems: string[] = [];
      for (const panel of PANELS) {
        http.route = `/operations?panel=${panel}`;
        await page.goto(`/operations?panel=${panel}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(400);
        if (/\/login/.test(page.url())) { problems.push(`${panel}: bounced to login`); continue; }
        const crashed = await page.locator('text=/Unhandled Runtime Error|Application error: a client-side exception|Internal Server Error/i').count();
        if (crashed) problems.push(`${panel}: crash screen`);
        if (key === 'sysadmin') await shot(page, `ops-${panel}`);
      }
      expect(problems, problems.join('\n')).toEqual([]);
      expect(http.failures, http.failures.join('\n')).toEqual([]);
      expect(notRequestNoise(watcher.errors), watcher.errors.join('\n')).toEqual([]);
      await page.context().close();
    });
  }
});

// ───────────────────────── 2. the Documents list shows what the access rules allow ─────────────────────────

/** [persona, documents they must see, documents they must NOT see] — titles from the seed. */
const VISIBILITY: [string, string[], string[]][] = [
  ['fin.staff1', ['QA Finance PDF report', 'QA Finance Excel ledger'], ['QA HR leave policy', 'QA Operations runbook', 'QA North sales deal']],
  ['fin.staff2', ['QA Finance Excel ledger', 'QA Finance Word memo by staff two'], ['QA Finance PDF report', 'QA Finance confidential salaries']],
  ['hr.staff', ['QA HR leave policy'], ['QA Finance PDF report', 'QA Finance confidential salaries']],
  ['north.staff', ['QA North sales deal'], ['QA Finance PDF report', 'QA North finance ledger']],
  ['north.fin', ['QA North finance ledger'], ['QA Finance PDF report', 'QA Finance Excel ledger']],
  ['no.dept', ['QA Finance PDF report'], ['QA Operations runbook', 'QA HR leave policy', 'QA Finance PNG scan']],
  // owner decision 2026-10-09: a parent-department head is not a member of its sub-departments
  ['fin.head', ['QA Finance PDF report'], ['QA Payables invoice batch', 'QA Receivables statement']],
  ['fap.staff', ['QA Payables invoice batch'], ['QA Finance PDF report']],
  ['auditor', ['QA Finance PDF report', 'QA HR leave policy', 'QA Operations runbook', 'QA North sales deal'], []],
  ['override', ['QA HR leave policy', 'QA Operations runbook'], []],
];

test.describe('the Documents list matches the access rules', () => {
  for (const [key, mustSee, mustNotSee] of VISIBILITY) {
    test(`${key} sees the right documents (list and UI agree)`, async ({ browser }) => {
      const page = await asPersona(browser, key);
      // what the API says this person may list
      const token = await page.evaluate(() => JSON.parse(window.localStorage.getItem('edams-auth') ?? '{}')?.state?.accessToken as string | undefined);
      expect(token, 'no session token in localStorage').toBeTruthy();
      // Every page, not just the first: other test runs keep adding documents, and a person who reads the whole tenant
      // (auditor, override) would otherwise see the seeded ones pushed past the first 100 newest.
      const titles: string[] = [];
      for (let skip = 0; skip < 2000; skip += 100) {
        const res = await page.request.get(`http://localhost:7100/api/v1/documents?take=100&skip=${skip}`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.ok()).toBeTruthy();
        const batch: string[] = ((await res.json()).data ?? []).map((d: { title: string }) => d.title);
        titles.push(...batch);
        if (batch.length < 100) break;
      }
      for (const t of mustSee) expect(titles, `${key} should list "${t}"`).toContain(t);
      for (const t of mustNotSee) expect(titles, `${key} must NOT list "${t}"`).not.toContain(t);

      // and the screen shows the same
      await page.goto('/dashboard/documents');
      await expectPageHealthy(page);
      await expect(page.getByRole('heading', { level: 1, name: /^(All Documents|My Scope)$/i })).toBeVisible();
      await page.waitForLoadState('networkidle').catch(() => {});
      const body = await page.locator('body').innerText();
      // oversight roles list dozens of documents over several pages; the API assertion above is the full check for them
      if (titles.length <= 20) {
        for (const t of mustSee.slice(0, 2)) expect(body, `${key}'s Documents screen should show "${t}"`).toContain(t);
      }
      for (const t of mustNotSee) expect(body, `${key}'s Documents screen must NOT show "${t}"`).not.toContain(t);
      await shot(page, `${key}-documents-list`);
      await page.context().close();
    });
  }

  test('an inactive person cannot sign in', async ({ request }) => {
    const res = await request.post('http://localhost:7100/api/v1/auth/login', { data: { email: email('inactive') } });
    expect(res.status()).toBe(401);
  });
});

// ───────────────────────── 3. real clicks ─────────────────────────

test.describe('real clicks', () => {
  test('My Work: the finance head approves a document waiting on the manager step', async ({ browser }) => {
    // provision a fresh item every run, so the click is repeatable: staff1 uploads, submits; the records officer clears the review step
    const author = await apiLogin(email('fin.staff1'));
    const records = await apiLogin(email('records'));
    const departments = (await apiGet(author, '/departments')).data as { id: string; code: string; orgUnitId: string }[];
    const orgUnits = (await apiGet(author, '/org-units')).data as { id: string; code: string; name: string }[];
    const hq = orgUnits.find((o) => o.code === 'HQ')!;
    const fin = departments.find((d) => d.code === 'FIN' && d.orgUnitId === hq.id)!;
    const title = `QA click approval ${Date.now()}`;
    const upload = await author.ctx.post('http://localhost:7100/api/v1/documents', {
      headers: { Authorization: `Bearer ${author.token}` },
      multipart: {
        title, departmentId: fin.id, documentTypeCode: 'QA-APPR', organisationUnit: hq.name, securityClassification: 'INTERNAL',
        retentionClass: 'RET-CORP-5Y', source: 'MANUAL_UPLOAD',
        file: { name: 'qa.pdf', mimeType: 'application/pdf', buffer: TINY_PDF },
      },
    });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    const uploaded = await upload.json();
    const created = uploaded.data ?? uploaded;
    const submitRes = await author.ctx.post(`http://localhost:7100/api/v1/approvals/DOCUMENT/${created.id}/submit`, { headers: { Authorization: `Bearer ${author.token}` }, data: {} });
    expect(submitRes.ok(), await submitRes.text()).toBeTruthy();
    const submitted = await submitRes.json();
    const chain = submitted.data ?? submitted;
    const review = chain.steps.find((x: { status: string }) => x.status === 'PENDING') ?? chain.steps[0];
    const decided = await records.ctx.post(`http://localhost:7100/api/v1/approvals/chains/${chain.id}/steps/${review.id}/decision`, { headers: { Authorization: `Bearer ${records.token}` }, data: { decision: 'APPROVE', comment: 'review done' } });
    expect(decided.ok(), await decided.text()).toBeTruthy();

    // the click: the finance head finds it in My Work and approves
    const page = await asPersona(browser, 'fin.head');
    await page.goto('/dashboard/mywork');
    await expect(page.getByRole('heading', { level: 1, name: /^My Work$/i })).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => {});
    await shot(page, 'fin.head-mywork');
    const row = page.getByText(title).first();
    await expect(row, 'the waiting item is not in the finance head My Work list').toBeVisible();
    await row.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await shot(page, 'fin.head-mywork-opened');
    const approve = page.getByRole('button', { name: /^approve/i }).first();
    await expect(approve, 'no Approve button for the waiting item').toBeVisible();
    await approve.click();
    const confirm = page.getByRole('button', { name: /^(approve|confirm|submit|yes)/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await page.waitForLoadState('networkidle').catch(() => {});

    const head = await apiLogin(email('fin.head'));
    const after = (await apiGet(head, `/documents/${created.id}`)).data ?? (await apiGet(head, `/documents/${created.id}`));
    expect(['ACTIVE', 'ARCHIVED'], `status after the click was ${after.status}`).toContain(after.status);
    await page.context().close();
  });

  test('Browse: a finance employee walks the folder tree to a document', async ({ browser }) => {
    const page = await asPersona(browser, 'fin.staff2');
    await page.goto('/dashboard/browse');
    await expectPageHealthy(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    await shot(page, 'fin.staff2-browse');
    const body = await page.locator('main').innerText();
    expect(body).toMatch(/Finance/);
    expect(body, 'a finance employee must not see another department in Browse').not.toMatch(/Human Resources|Engineering|Store Floor|North Branch/);
    await page.context().close();
  });

  test('Operations › Departments (new Show deactivated switch) renders for a system admin', async ({ browser }) => {
    const page = await asPersona(browser, 'sysadmin');
    await page.goto('/operations?panel=departments');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByText(/show deactivated/i).first()).toBeVisible();
    await shot(page, 'sysadmin-departments');
    await page.context().close();
  });

  test('Operations › Document Types (Show deactivated) renders for a system admin', async ({ browser }) => {
    const page = await asPersona(browser, 'sysadmin');
    await page.goto('/operations?panel=docTypes');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByText(/show deactivated/i).first()).toBeVisible();
    await page.context().close();
  });

  test('a multi-role person is asked which role to sign in as, and both roles are offered', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByRole('textbox', { name: /email/i }).fill(email('multi.role'));
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL(/select-role/, { timeout: 60_000 });
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/APPROVER|Approver/);
    expect(body).toMatch(/EMPLOYEE|Employee/);
    await shot(page, 'multi.role-select-role');
    await context.close();
  });

  test('an employee with no department still reaches the dashboard and sees their one granted document', async ({ browser }) => {
    const page = await asPersona(browser, 'no.dept');
    await page.goto('/dashboard/documents');
    await expectPageHealthy(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('body')).toContainText('QA Finance PDF report');
    await page.context().close();
  });
});

// ───────────────────────── 5.13 sidebar collapse and hierarchy width ─────────────────────────

test.describe('layout', () => {
  test('the sidebar collapses to icons, widens again, stays within 30% of the window and remembers its width', async ({ browser }) => {
    const page = await asPersona(browser, 'fin.staff1');
    await page.goto('/dashboard');
    const handle = page.getByRole('separator', { name: 'Resize sidebar' });
    await expect(handle).toBeVisible();
    const width = async () => Number(await handle.getAttribute('aria-valuenow'));
    const start = await width();
    expect(start).toBeGreaterThan(200);

    await handle.focus();
    for (let i = 0; i < 20 && (await width()) > 60; i += 1) await page.keyboard.press('ArrowLeft');
    expect(await width(), 'the sidebar did not reach icon mode').toBeLessThanOrEqual(60);
    const collapsed = await page.getByRole('navigation', { name: 'Main navigation' }).boundingBox();
    expect(collapsed!.width).toBeLessThan(100);
    await shot(page, 'sidebar-collapsed');

    // remembered across a reload
    await page.reload();
    expect(Number(await page.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow'))).toBeLessThanOrEqual(60);

    // widen: never past 30% of the window
    const h2 = page.getByRole('separator', { name: 'Resize sidebar' });
    await h2.focus();
    for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowRight');
    const viewport = page.viewportSize()!;
    expect(Number(await h2.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Math.ceil(viewport.width * 0.3) + 1);
    await page.context().close();
  });

  test('the Hierarchy Browser uses the width it is given and a node can be folded and unfolded', async ({ browser }) => {
    const page = await asPersona(browser, 'sysadmin');
    await page.goto('/operations?panel=hierarchy');
    await page.waitForLoadState('networkidle').catch(() => {});
    const row = page.locator('div[role="button"]', { hasText: 'QA Laboratory' }).first();
    await expect(row, 'the tenant root is not shown').toBeVisible();
    const box = await row.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width, 'the tree is squeezed into a sliver').toBeGreaterThan(viewport.width * 0.2);
    await shot(page, 'hierarchy-browser');
    // fold and unfold the first node that has a chevron
    const chevron = page.locator('div[role="button"] button:has(svg)').first();
    await expect(chevron).toBeVisible();
    const before = await page.locator('div[role="button"]').count();
    await chevron.click();
    await page.waitForTimeout(600);
    const after = await page.locator('div[role="button"]').count();
    expect(after, 'folding or unfolding a node changed nothing').not.toBe(before);
    await page.context().close();
  });
});

// ───────────────────────── 5.14 the platform administrator in DMS ─────────────────────────

test.describe('platform administrator is invisible in DMS', () => {
  test('never listed to a system administrator, and never offered as a role', async ({ browser }) => {
    const page = await asPersona(browser, 'sysadmin');
    const token = await page.evaluate(() => JSON.parse(window.localStorage.getItem('edams-auth') ?? '{}')?.state?.accessToken as string);
    const headers = { Authorization: `Bearer ${token}` };
    const users = await (await page.request.get('http://localhost:7100/api/v1/users?take=500', { headers })).json();
    const emails = JSON.stringify(users);
    expect(emails).not.toContain('dawitbk01@gmail.com');
    expect(emails).not.toContain('someone@example.com');
    const roles = await (await page.request.get('http://localhost:7100/api/v1/roles', { headers })).json();
    expect(JSON.stringify(roles)).not.toContain('PLATFORM_ADMIN');
    await page.goto('/operations?panel=roles');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(await page.locator('body').innerText()).not.toMatch(/PLATFORM_ADMIN|Platform Admin/);
    await page.context().close();
  });
});
