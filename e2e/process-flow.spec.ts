import { test, expect, signIn, expectPageHealthy, watchConsole } from './fixtures/app';
import { apiLogin, apiGet, apiPost, TINY_PDF, type ApiSession } from './fixtures/api';
import type { Browser, Page } from '@playwright/test';

/**
 * The process-flow flexibility added on 2026-10-10, driven through the real screens:
 *   - a drafter recalls a letter out of review to edit it,
 *   - a step can be given a deadline when the letter is submitted (and shows as due),
 *   - an approval recipe can be a catch-all default, be edited, and be switched off,
 *   - the Chain Integrity panel verifies and lists breaks.
 * Uses the QA tenant built by backend `npm run db:seed:qa`.
 */

const email = (key: string) => `qa.${key}@qa.local`;

async function asPersona(browser: Browser, key: string): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, email(key));
  return page;
}

async function hqFinance(s: ApiSession) {
  const orgUnits = (await apiGet(s, '/org-units')).data;
  const departments = (await apiGet(s, '/departments')).data;
  const orgUnit = orgUnits.find((o: any) => o.code === 'HQ') ?? orgUnits[0];
  const department = departments.find((d: any) => d.code === 'FIN' && d.orgUnitId === orgUnit.id) ?? departments.find((d: any) => d.orgUnitId === orgUnit.id);
  return { orgUnit, department };
}

async function draftLetter(author: ApiSession, subject: string) {
  const { orgUnit, department } = await hqFinance(author);
  return (await apiPost(author, '/letters', {
    orgUnitId: orgUnit.id, departmentId: department.id, subject, bodyHtml: '<p>flow</p>', letterType: 'OUT', correspondent: 'Someone',
  })).data;
}

test.describe('letters: recall and deadlines', () => {
  test('the drafter recalls a letter that is in review, and gets it back to edit', async ({ browser }) => {
    const author = await apiLogin(email('fin.staff1'));
    const approver = await apiLogin(email('fin.approver'));
    const letter = await draftLetter(author, `Recall UI ${Date.now()}`);
    await apiPost(author, `/letters/${letter.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.user.id }] });

    const page = await asPersona(browser, 'fin.staff1');
    const watcher = watchConsole(page);
    await page.goto(`/dashboard/letters/${letter.id}`);
    await expectPageHealthy(page);
    await page.getByRole('button', { name: /recall to edit/i }).click();
    await expect(page.getByText(/Steps nobody has decided yet are cancelled/i)).toBeVisible();
    await page.getByRole('button', { name: /^recall letter$/i }).click();
    await expect(page.getByRole('button', { name: /edit draft/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /recall to edit/i })).toHaveCount(0);
    expect(watcher.errors.filter((e) => !/Failed to load resource/i.test(e)), watcher.errors.join('\n')).toEqual([]);
    await page.context().close();
  });

  test('only the drafter is offered Recall', async ({ browser }) => {
    const author = await apiLogin(email('fin.staff1'));
    const approver = await apiLogin(email('fin.approver'));
    const letter = await draftLetter(author, `Recall owner ${Date.now()}`);
    await apiPost(author, `/letters/${letter.id}/submit`, { steps: [{ stepType: 'APPROVE', assignedUserId: approver.user.id }] });
    const page = await asPersona(browser, 'fin.approver');
    await page.goto(`/dashboard/letters/${letter.id}`);
    await expectPageHealthy(page);
    await expect(page.getByRole('button', { name: /recall to edit/i })).toHaveCount(0);
    await page.context().close();
  });

  test('a step can be given a deadline at submit time, and the chain shows it as due', async ({ browser }) => {
    const author = await apiLogin(email('fin.staff1'));
    const letter = await draftLetter(author, `Deadline UI ${Date.now()}`);
    const page = await asPersona(browser, 'fin.staff1');
    await page.goto(`/dashboard/letters/${letter.id}`);
    await expectPageHealthy(page);
    await page.getByRole('button', { name: /^submit$/i }).click();
    const deadline = page.getByLabel('Deadline for step 1');
    await expect(deadline).toBeVisible();
    await deadline.selectOption('48');
    await page.getByRole('button', { name: /submit for approval/i }).click();
    // wait for the submit itself (the letter is in review), not for any text that merely starts with "Due"
    await expect.poll(async () => (await apiGet(author, `/letters/${letter.id}`)).data.status, { timeout: 20_000 }).toBe('IN_REVIEW');
    await page.reload();
    await expect(page.getByTitle(/^Deadline /).first()).toBeVisible({ timeout: 15_000 });
    const after = (await apiGet(author, `/letters/${letter.id}`)).data;
    const step = (after.approvalSteps ?? []).find((s: any) => s.status === 'PENDING');
    expect(step, `letter ${after.status}, steps ${JSON.stringify((after.approvalSteps ?? []).map((s: any) => [s.status, s.slaHours]))}`).toBeTruthy();
    expect(step.slaHours).toBe(48);
    expect(step.dueAt).toBeTruthy();
    await page.context().close();
  });
});

test.describe('operations: approval recipes and chain integrity', () => {
  test('a catch-all default recipe shows up, can be edited, and can be switched off', async ({ browser }) => {
    const admin = await apiLogin(email('sysadmin'));
    const { orgUnit } = await hqFinance(admin);
    // start clean for this org unit, then create the default through the API (the editor is covered below)
    const existing = (await apiGet(admin, '/approvals/templates')).data as any[];
    for (const t of existing.filter((x) => x.isActive && !x.documentTypeId && !x.formTemplateId && !x.forFormTemplates && x.orgUnitId === orgUnit.id)) {
      await admin.ctx.delete(`${process.env.API_URL ?? 'http://localhost:7100/api/v1'}/approvals/templates/${t.id}`, { headers: { Authorization: `Bearer ${admin.token}` } });
    }
    await apiPost(admin, '/approvals/templates', { isDefault: true, orgUnitId: orgUnit.id, name: 'E2E HQ default', steps: [{ stepType: 'APPROVE', assignedRole: 'EXECUTIVE' }] });

    const page = await asPersona(browser, 'sysadmin');
    await page.goto('/operations?panel=approvalChains');
    await page.waitForLoadState('networkidle').catch(() => {});
    const card = page.locator('.ui-card', { hasText: 'E2E HQ default' }).last();
    await expect(card.getByText('Default (everything else)')).toBeVisible();
    await expect(card.getByRole('button', { name: /edit/i })).toBeVisible();

    // Edit loads the recipe into the editor with the Default tab selected
    await card.getByRole('button', { name: /edit/i }).click();
    await expect(page.getByTestId('recipe-default-help')).toBeVisible();
    await page.getByRole('button', { name: /cancel/i }).first().click();

    page.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: /switch off/i }).click();
    await expect(page.getByText('E2E HQ default')).toHaveCount(0, { timeout: 15_000 });
    await page.context().close();
  });

  test('Chain Integrity verifies and says so', async ({ browser }) => {
    const page = await asPersona(browser, 'sysadmin');
    await page.goto('/operations?panel=integrity');
    await page.getByRole('button', { name: /verify chain integrity/i }).click();
    await expect(page.getByText(/Chain Valid|Chain valid, with acknowledged|Chain Broken/).first()).toBeVisible({ timeout: 30_000 });
    await page.context().close();
  });
});

test.describe('CRUD gaps closed on 2026-10-10: custom roles, bundles, webhooks', () => {
  test('a custom role can be given a new description and deleted; a built-in role has neither button', async ({ browser }) => {
    const admin = await apiLogin(email('sysadmin'));
    const name = `E2E_ROLE_${Date.now()}`;
    await apiPost(admin, '/roles', { name, description: 'made by the browser test' });
    const page = await asPersona(browser, 'sysadmin');
    await page.goto('/operations?panel=roles');
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByLabel(`Delete role EMPLOYEE`)).toHaveCount(0);
    await expect(page.getByLabel(`Edit description of EMPLOYEE`)).toHaveCount(0);

    await page.getByLabel(`Edit description of ${name}`).click();
    await page.getByLabel('Role description').fill('described again');
    await page.getByRole('button', { name: /save description/i }).click();
    await expect(page.getByText('described again').first()).toBeVisible({ timeout: 15_000 });

    page.once('dialog', (d) => d.accept());
    await page.getByLabel(`Delete role ${name}`).click();
    await expect(page.getByText(name)).toHaveCount(0, { timeout: 15_000 });
    await page.context().close();
  });

  test('a bundle can be renamed and deleted by the person who made it', async ({ browser }) => {
    const author = await apiLogin(email('fin.staff1'));
    const created = (await apiPost(author, '/bundles', { name: `Bundle before ${Date.now()}` })).data;
    const page = await asPersona(browser, 'fin.staff1');
    await page.goto(`/dashboard/bundles/${created.id}`);
    await expectPageHealthy(page);
    await page.getByRole('button', { name: /^rename$/i }).click();
    await page.getByLabel('Bundle name').fill('Bundle after the rename');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByRole('heading', { name: 'Bundle after the rename' })).toBeVisible({ timeout: 15_000 });
    expect((await apiGet(author, `/bundles/${created.id}`)).data.name).toBe('Bundle after the rename');

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /^delete$/i }).click();
    await page.waitForURL(/\/dashboard\/bundles$/, { timeout: 15_000 });
    const res = await author.ctx.get(`${process.env.API_URL ?? 'http://localhost:7100/api/v1'}/bundles/${created.id}`, { headers: { Authorization: `Bearer ${author.token}` } });
    expect(res.status(), 'the deleted bundle is gone').toBe(404);
    await page.context().close();
  });

  test('someone who did not make a bundle cannot rename or delete it', async () => {
    const author = await apiLogin(email('fin.staff1'));
    const other = await apiLogin(email('fin.staff2'));
    const created = (await apiPost(author, '/bundles', { name: `Not yours ${Date.now()}` })).data;
    const api = process.env.API_URL ?? 'http://localhost:7100/api/v1';
    const headers = { Authorization: `Bearer ${other.token}` };
    const patch = await other.ctx.patch(`${api}/bundles/${created.id}`, { headers, data: { name: 'hijacked' } });
    const del = await other.ctx.delete(`${api}/bundles/${created.id}`, { headers });
    // an empty bundle is only visible to its creator, so another person gets 404; a bundle they can see gets 403. Either way: refused.
    expect([403, 404]).toContain(patch.status());
    expect([403, 404]).toContain(del.status());
    expect((await apiGet(author, `/bundles/${created.id}`)).data.name).toMatch(/^Not yours/);
  });

  test('a webhook can be paused, resumed and edited from its screen', async ({ browser }) => {
    const admin = await apiLogin(email('sysadmin'));
    const api = process.env.API_URL ?? 'http://localhost:7100/api/v1';
    const created = await admin.ctx.post(`${api}/webhooks`, { headers: { Authorization: `Bearer ${admin.token}` }, data: { url: `https://example.com/hook-${Date.now()}`, secret: 'a-test-secret-of-16-chars' } });
    test.skip(!created.ok(), `could not register a webhook here (needs DNS): ${created.status()}`);
    const sub = await created.json();
    try {
      const page = await asPersona(browser, 'sysadmin');
      await page.goto('/operations?panel=webhooks');
      await page.waitForLoadState('networkidle').catch(() => {});
      const row = page.locator('div.py-3', { hasText: sub.url }).last();
      await expect(row.getByText('Active')).toBeVisible();
      await row.getByRole('button', { name: /^pause$/i }).click();
      await expect(row.getByText(/Paused/)).toBeVisible({ timeout: 15_000 });
      await row.getByRole('button', { name: /^resume$/i }).click();
      await expect(row.getByText('Active')).toBeVisible({ timeout: 15_000 });
      await row.getByRole('button', { name: /^edit$/i }).click();
      await expect(page.getByTestId('webhook-editor')).toBeVisible();
      // the form no longer asks for a tenant: the server takes it from the sign-in
      await expect(page.getByText('Tenant ID')).toHaveCount(0);
      await page.context().close();
    } finally {
      await admin.ctx.delete(`${api}/webhooks/${sub.id}`, { headers: { Authorization: `Bearer ${admin.token}` } });
    }
  });
});

test.describe('classification closes a document (option B, 2026-10-10)', () => {
  const TITLE = 'QA Finance PDF report';
  const listed = async (s: ApiSession) => ((await apiGet(s, `/documents?take=20&q=${encodeURIComponent(TITLE)}`)).data as Array<{ title: string }>).some((d) => d.title === TITLE);

  test('an owner makes a document Confidential: a department colleague stops seeing it, the head and an auditor still do; lowering needs a reason', async ({ browser }) => {
    const owner = await apiLogin(email('fin.staff1'));
    const colleague = await apiLogin(email('fin.approver'));
    const head = await apiLogin(email('fin.head'));
    const auditor = await apiLogin(email('auditor'));
    const doc = ((await apiGet(owner, `/documents?take=20&q=${encodeURIComponent(TITLE)}`)).data as Array<{ id: string; title: string; securityClassification: string }>).find((d) => d.title === TITLE)!;
    expect(doc, 'the practice document exists (npm run db:seed:qa)').toBeTruthy();
    test.skip(doc.securityClassification !== 'INTERNAL', `expected the practice document to be Internal, it is ${doc.securityClassification}`);
    expect(await listed(colleague), 'before: a department colleague sees it').toBe(true);

    const page = await asPersona(browser, 'fin.staff1');
    try {
      await page.goto(`/dashboard/documents/${doc.id}`);
      await expectPageHealthy(page);
      await expect(page.getByTestId('classification-badge')).toContainText('INTERNAL');
      await page.getByRole('button', { name: 'Change classification' }).first().click();
      await page.locator('#classification-select').selectOption('CONFIDENTIAL');
      await expect(page.getByTestId('classification-explainer')).toContainText('head of the department');
      await page.getByRole('button', { name: 'Change classification' }).last().click();
      await expect(page.getByTestId('classification-badge')).toContainText('CONFIDENTIAL', { timeout: 15_000 });

      expect(await listed(owner), 'the owner still sees it').toBe(true);
      expect(await listed(colleague), 'a department colleague no longer sees it').toBe(false);
      expect(await listed(head), 'the department head still sees a CONFIDENTIAL one').toBe(true);
      expect(await listed(auditor), 'an oversight role still sees it').toBe(true);
      const blocked = await colleague.ctx.get(`${process.env.API_URL ?? 'http://localhost:7100/api/v1'}/documents/${doc.id}`, { headers: { Authorization: `Bearer ${colleague.token}` } });
      expect(blocked.status(), 'and cannot open it by its address either').toBeGreaterThanOrEqual(403);

      // restricted: not even the head
      await page.getByRole('button', { name: 'Change classification' }).first().click();
      await page.locator('#classification-select').selectOption('RESTRICTED');
      await expect(page.getByTestId('classification-explainer')).toContainText('Not even the head');
      await page.getByRole('button', { name: 'Change classification' }).last().click();
      await expect(page.getByTestId('classification-badge')).toContainText('RESTRICTED', { timeout: 15_000 });
      expect(await listed(head), 'the head no longer sees a RESTRICTED one').toBe(false);
      expect(await listed(auditor)).toBe(true);

      // lowering: the confirm button waits for a reason
      await page.getByRole('button', { name: 'Change classification' }).first().click();
      await page.locator('#classification-select').selectOption('INTERNAL');
      const confirm = page.getByRole('button', { name: 'Change classification' }).last();
      await expect(confirm).toBeDisabled();
      await page.getByLabel('Reason for lowering the classification').fill('Checked with the owner: no longer sensitive');
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(page.getByTestId('classification-badge')).toContainText('INTERNAL', { timeout: 15_000 });
      expect(await listed(colleague), 'a department colleague sees it again').toBe(true);
    } finally {
      // leave the practice document as it was found
      await owner.ctx.patch(`${process.env.API_URL ?? 'http://localhost:7100/api/v1'}/documents/${doc.id}/classification`, {
        headers: { Authorization: `Bearer ${owner.token}` },
        data: { classification: 'INTERNAL', reason: 'restoring the practice document after the test' },
      });
      await page.context().close();
    }
  });

  test('the upload form explains what each class means', async ({ browser }) => {
    const page = await asPersona(browser, 'fin.staff1');
    await page.goto('/dashboard/upload');
    await expectPageHealthy(page);
    // step 1 needs a file before the details step (where the class is chosen) opens
    await page.locator('input[type="file"]').setInputFiles({ name: 'classification-help.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    await page.getByRole('button', { name: 'Next Step' }).first().click();
    const select = page.locator('select[name="securityClassification"]');
    await select.selectOption('RESTRICTED');
    await expect(page.getByTestId('upload-classification-help')).toContainText('Not even the head');
    await select.selectOption('INTERNAL');
    await expect(page.getByTestId('upload-classification-help')).toContainText('Everyone in the department');
    await page.context().close();
  });
});
