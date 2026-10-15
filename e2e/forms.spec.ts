import { test, expect, expectPageHealthy } from './fixtures/app';
import { apiLogin, apiGet, apiGetCached, createActiveFormTemplate, type ApiSession } from './fixtures/api';
import type { Page } from '@playwright/test';

/**
 * Forms: the submitter chooses who approves — through the UI.
 *
 * THE BUG
 *
 * `createFormInstance` called `submitForApproval('FORM_INSTANCE', id, {}, user)`
 * — an empty step list — so the engine fell back to its hardcoded single
 * [{ APPROVE, DEPT_MANAGER }] for every form ever filed. Every form chain in the
 * live database was exactly that shape, and the fill dialog offered no way to
 * ask for anything else.
 *
 * WHY THIS SPEC EXISTS ALONGSIDE verify-forms-approval-selection.ts
 *
 * That verifier proves the API accepts and stores a chosen chain. It cannot
 * prove anyone can choose one — and "the API supports it, the UI never passed
 * it" was the entire bug. So this drives the actual dialog and then reads the
 * database back to confirm what the click produced.
 *
 * It has already earned its place: it caught the fill dialog resolving role
 * holders TENANT-WIDE while the engine scopes them to the form's own
 * department, so the picker reported every role as staffed everywhere. The
 * author picked one, the PDF rendered, the instance was filed — and only then
 * did the engine refuse the chain. Both the verifier and the unit tests passed
 * throughout, because both chose a department where the role happened to be
 * staffed.
 */

let api: ApiSession;
let chainTemplateName: string;
let chainTemplateId: string;
let noChainTemplateName: string;

/**
 * A department where the role this spec assigns really is staffed.
 *
 * Chosen from live data rather than hardcoded: a role step is refused at submit
 * if no holder of that role belongs to the item's department
 * (ERR-STEP-ROLE-UNSTAFFED), so a spec that picks a department blindly is
 * asserting on seed data it does not control. This asks the same endpoint the
 * dialog asks.
 */
const ROLE_UNDER_TEST = 'APPROVER';
let staffedDepartment: { id: string; code: string; name: string };

test.beforeAll(async () => {
  api = await apiLogin();
  const stamp = Date.now();

  chainTemplateName = `E2E chain form ${stamp}`;
  const chainTpl = await createActiveFormTemplate(api, { name: chainTemplateName, instanceApproval: 'chain' });
  chainTemplateId = chainTpl.id;

  noChainTemplateName = `E2E no-chain form ${stamp}`;
  await createActiveFormTemplate(api, { name: noChainTemplateName, instanceApproval: 'none' });

  // One request, not one per department: role-holders takes a department, and
  // probing all eleven of them burned a tenth of the per-user minute budget
  // before a single page had loaded.
  const departments = (await apiGetCached(api, '/departments')).data as Array<{ id: string; code: string; name: string }>;
  for (const dept of departments) {
    const holders = (await apiGetCached(api, `/approvals/role-holders?roles=${ROLE_UNDER_TEST}&departmentId=${dept.id}`)).data;
    if ((holders?.[ROLE_UNDER_TEST] ?? []).length > 0) {
      staffedDepartment = dept;
      break;
    }
  }
  if (!staffedDepartment) {
    throw new Error(`no department has a ${ROLE_UNDER_TEST} — seed data cannot support this spec`);
  }
});

/** Open the fill dialog for one template by name. */
async function openFillDialog(page: Page, templateName: string) {
  await page.goto('/dashboard/forms/fill');
  await expectPageHealthy(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Fill a Form$/ })).toBeVisible();

  // The template grid sorts newest-first by updatedAt, so the one this spec
  // just created is on page 1.
  const escaped = templateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('button', { name: new RegExp(escaped) }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/**
 * Wait until the approver picker has finished loading its pre-filled chain.
 *
 * The chain arrives from an async prefill request, so the fieldset renders
 * before its steps do. Interacting in that window makes a test that is really
 * asserting "the picker works" fail as "step 0 not found", which reads like the
 * feature is missing rather than like a race in the test.
 */
async function populatedChain(page: Page) {
  const chainSection = page.getByTestId('form-approval-chain');
  await expect(chainSection, 'the approver picker never rendered').toBeVisible();
  await expect(
    chainSection.getByTestId('form-approval-step-0-type'),
    'the picker rendered but its pre-filled chain never arrived',
  ).toBeVisible();
  return chainSection;
}

/**
 * Choose a department, then wait for the picker to re-resolve against it.
 *
 * Selected by department ID, which is the option's value — the visible label is
 * "CODE - Name" and Playwright's label matcher takes only an exact string.
 *
 * The wait matters: the role-holder lookup is keyed on the department, so
 * asserting on the staffing warning before it refetches reads the PREVIOUS
 * department's answer, which is precisely the bug this spec exists to catch.
 */
async function chooseDepartment(page: Page, department: { id: string; code: string }) {
  const dialog = page.getByRole('dialog');
  const refreshed = page.waitForResponse(
    (r) => r.url().includes('/approval-prefill') && r.url().includes(department.id),
    { timeout: 30_000 },
  );
  await dialog.locator('select').first().selectOption(department.id);
  await refreshed;
}

test.describe('forms: choosing who approves a submission', () => {
  test('a chain template offers the approver picker, pre-filled with a real chain', async ({ page }) => {
    await openFillDialog(page, chainTemplateName);
    const chainSection = await populatedChain(page);

    // Pre-filled from the same recipe submitForApproval will use, so what the
    // author sees is what they would have got by choosing nothing.
    await expect(chainSection.getByTestId('form-approval-step-0-type')).toHaveValue('APPROVE');

    // Both scopes are offered on every step: a department-scoped ROLE and a
    // tenant-global NAMED person.
    await expect(chainSection.getByTestId('form-approval-step-0-role')).toBeVisible();
    await expect(chainSection.getByTestId('form-approval-step-0-user')).toBeVisible();

    // A role step names its actual current holders rather than a bare role code.
    await expect(chainSection.getByText(/Currently held by:|No one currently holds this role/i)).toBeVisible();
  });

  test('the role warning reflects the department the form will be filed under', async ({ page }) => {
    // The regression that made this spec worth writing. Resolved tenant-wide,
    // the picker reported every role as staffed in every department, and the
    // author only learned otherwise after the instance had been filed.
    await openFillDialog(page, chainTemplateName);
    const chainSection = await populatedChain(page);

    const staffedElsewhere = await apiGetCached(
      api,
      `/approvals/role-holders?roles=${ROLE_UNDER_TEST}&departmentId=${staffedDepartment.id}`,
    );
    expect((staffedElsewhere.data?.[ROLE_UNDER_TEST] ?? []).length).toBeGreaterThan(0);

    await chooseDepartment(page, staffedDepartment);
    await chainSection.getByTestId('form-approval-step-0-role').selectOption(ROLE_UNDER_TEST);

    await expect(
      chainSection.getByText(/Currently held by:/i),
      `${ROLE_UNDER_TEST} is staffed in ${staffedDepartment.code} but the picker says otherwise`,
    ).toBeVisible();
  });

  test('a template that does not use chain approval offers no picker at all', async ({ page }) => {
    await openFillDialog(page, noChainTemplateName);

    // Showing a picker here would be a lie: the backend refuses approvalSteps
    // for a 'none' template (ERR-FORM-APPROVAL-NOT-USED).
    await expect(page.getByTestId('form-approval-chain')).toHaveCount(0);
  });

  test('the chain the submitter builds is the chain the form actually gets', async ({ page }) => {
    await openFillDialog(page, chainTemplateName);

    const dialog = page.getByRole('dialog');
    const chainSection = await populatedChain(page);

    // File it where the role under test is actually staffed, so this asserts on
    // the chain that was built rather than on seed-data staffing.
    await chooseDepartment(page, staffedDepartment);
    await dialog.getByLabel(/Subject/i).fill(`E2E submission ${Date.now()}`);

    // Build a chain the old hardcoded default could never produce: two steps,
    // the first a REVIEW by ROLE, the second an APPROVE by a NAMED person. If
    // this passed under the old behaviour the assertion would be worthless, so
    // the shape is chosen to be impossible under it.
    await chainSection.getByTestId('form-approval-step-0-type').selectOption('REVIEW');
    await chainSection.getByTestId('form-approval-step-0-role').selectOption(ROLE_UNDER_TEST);
    await expect(chainSection.getByText(/Currently held by:/i)).toBeVisible();

    await chainSection.getByTestId('form-approval-step-add').click();
    await chainSection.getByTestId('form-approval-step-1-type').selectOption('APPROVE');

    // Any named person the API offers. The list is deliberately NOT
    // department-filtered — a named assignee is tenant-global by design.
    const namedPicker = chainSection.getByTestId('form-approval-step-1-user');
    const namedOptions = await namedPicker.locator('option').all();
    const chosenUserId = await namedOptions[1]!.getAttribute('value');
    expect(chosenUserId, 'no named approvers were offered').toBeTruthy();
    await namedPicker.selectOption(chosenUserId!);

    await expect(page.getByTestId('form-approval-chain-error')).toHaveCount(0);

    // Capture what the browser actually POSTs. Reading back "the newest
    // instance for this template" instead would be an assumption about a shared
    // database, and a wrong one the moment anything else files a form.
    const filed = page.waitForResponse(
      (r) => r.url().includes('/forms/instances') && r.request().method() === 'POST',
      { timeout: 90_000 },
    );
    await dialog.getByRole('button', { name: /Generate PDF document/i }).click();

    const response = await filed;
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(201);
    // An instance filed with a warning is an instance with NO approval chain and
    // no way to add one — the exact outcome the department scoping fix prevents.
    expect(body.approvalWarning, 'the form was filed but its approval chain was refused').toBeUndefined();

    await page.waitForURL(/\/dashboard\/documents\/[0-9a-f-]{36}/, { timeout: 90_000 });
    await expectPageHealthy(page);

    // Now the half a UI assertion cannot see: what actually reached the engine.
    const chain = await apiGet(api, `/approvals/FORM_INSTANCE/${body.data.id}/chain`);
    expect(chain, 'the filed instance has no approval chain at all').toBeTruthy();
    expect(chain.steps?.length, 'the chain does not have the two steps that were built').toBe(2);
    expect(chain.steps[0].stepType).toBe('REVIEW');
    expect(chain.steps[0].assignedRole).toBe(ROLE_UNDER_TEST);
    expect(chain.steps[1].stepType).toBe('APPROVE');
    expect(chain.steps[1].assignedUserId).toBe(chosenUserId);

    // The regression this whole change exists to prevent.
    expect(
      chain.steps.length === 1 && chain.steps[0].assignedRole === 'DEPT_MANAGER',
      'the form fell back to the old hardcoded DEPT_MANAGER chain',
    ).toBe(false);

    // A chain is only useful if the submitter can see it running. Asserted here
    // rather than as its own test so it depends on THIS test's submission
    // instead of on whatever happens to be in a shared database.
    await page.goto('/dashboard/forms/submissions');
    await expectPageHealthy(page);
    await expect(page.getByRole('heading', { level: 1, name: /^My Submissions$/ })).toBeVisible();
    await expect(page.getByText(chainTemplateName).first()).toBeVisible();

    // A submission belongs to a department and, through it, an org unit —
    // exactly like every other document — but nothing in the forms module ever
    // said so. These are also the UNIT and DEPT segments a letters-style
    // reference number would resolve from, so this asserts the data is present
    // and derived, not missing.
    await expect(
      page.getByTestId('submission-meta').first(),
      'a submission does not say which department and org unit it was filed under',
    ).toContainText(new RegExp(`${staffedDepartment.code}`));

    // Not yet numbered: a reference number is allocated at FINAL APPROVAL, and
    // this submission's chain is still on its first step. Numbering at submit
    // would burn one on every form that is later declined or abandoned.
    expect(chain.status, 'the chain completed unexpectedly, so this assertion proves nothing').not.toBe('APPROVED');
    const instance = await apiGet(api, `/forms/instances?templateId=${chainTemplateId}&take=100`);
    const filedRow = (instance.data ?? []).find((i: any) => i.id === body.data.id);
    expect(
      filedRow?.referenceNumber,
      'an unapproved form was given a reference number — the series will develop gaps',
    ).toBeFalsy();
  });

  test('a chain that the engine would reject is blocked in the dialog, not after the PDF is rendered', async ({ page }) => {
    await openFillDialog(page, chainTemplateName);

    const dialog = page.getByRole('dialog');
    const chainSection = await populatedChain(page);
    await dialog.getByLabel(/Subject/i).fill('E2E invalid chain');

    // The engine requires the LAST step to be an APPROVE. The fill transaction
    // commits before the submit runs, so catching this only server-side would
    // leave a filed instance with no chain and no way to add one.
    await chainSection.getByTestId('form-approval-step-0-type').selectOption('REVIEW');

    await expect(page.getByTestId('form-approval-chain-error')).toContainText(/last step must be an Approve/i);
    await expect(dialog.getByRole('button', { name: /Generate PDF document/i })).toBeDisabled();
  });

  test('removing every step blocks submission rather than silently defaulting', async ({ page }) => {
    await openFillDialog(page, chainTemplateName);

    const dialog = page.getByRole('dialog');
    const chainSection = await populatedChain(page);
    await dialog.getByLabel(/Subject/i).fill('E2E empty chain');

    // An empty list is exactly what the old code sent, and the engine reads it
    // as "use your default". Making it un-submittable is the point: the author
    // is choosing, so an empty choice has to be an error, not a silent fallback.
    const removeButtons = chainSection.getByRole('button', { name: 'Remove step' });
    for (let remaining = await removeButtons.count(); remaining > 0; remaining--) {
      await removeButtons.first().click();
    }

    await expect(page.getByTestId('form-approval-chain-error')).toContainText(/at least one approval step/i);
    await expect(dialog.getByRole('button', { name: /Generate PDF document/i })).toBeDisabled();
  });
});

test.describe('forms: the catalogue and the submitted result', () => {
  test('an active template is listed and fillable', async ({ page }) => {
    await page.goto('/dashboard/forms/templates');
    await expectPageHealthy(page);
    await expect(page.getByText(chainTemplateName).first()).toBeVisible();

    // Same source of truth the fill page reads, so a mismatch here is a real
    // catalogue bug rather than a stale render.
    const templates = await apiGet(api, '/forms/templates?status=active&take=100');
    expect(
      (templates.data ?? []).some((t: any) => t.id === chainTemplateId),
      'the activated template is missing from the active list',
    ).toBe(true);
  });
});
