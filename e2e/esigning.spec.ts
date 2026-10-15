import { test, expect, expectPageHealthy, watchConsole } from './fixtures/app';
import { apiLogin, apiGetCached as apiGet, type ApiSession } from './fixtures/api';

/**
 * E-signing: the page mounts, and all three recipient kinds are reachable.
 *
 * WHY THE MOUNT ASSERTION IS THE POINT
 *
 * This page is the one that broke hardest on 2026-09-03, and it broke in a way
 * no API test could see: a production build written into a live dev server's
 * `.next` left mixed chunks, the pdf.js worker failed to resolve, and the page
 * died on mount with `sendWithPromise of null`. Meanwhile verify-cams passed
 * 38/38 the entire time, because the whole letter + e-signing lifecycle is
 * healthy server-side. Clicking "Initiate Signing" just navigated to a page
 * that threw.
 *
 * So this spec asserts what only a browser can: the route compiles, the PDF
 * machinery loads, and the console stays clean.
 *
 * THE RECIPIENT KINDS
 *
 * A signer can be a NAMED internal user (tenant-wide search, not
 * department-filtered), a ROLE (department-scoped, unclaimed until the first
 * holder signs), or an EXTERNAL name+email. All three already existed here —
 * this pins them so the letters-side split cannot quietly diverge from the
 * generic signing page.
 */

let api: ApiSession;

test.beforeAll(async () => {
  api = await apiLogin();
});

test.describe('e-signing: the ceremony builder', () => {
  test('the page mounts with its PDF machinery and no console errors', async ({ page }) => {
    const consoleWatcher = watchConsole(page);

    await page.goto('/dashboard/signing');
    await expectPageHealthy(page);
    await expect(page.getByRole('heading', { level: 1, name: /^E-signing$/ })).toBeVisible();

    // Give the pdf.js worker time to fail if it is going to. The original
    // failure surfaced only as a console error, after the shell had rendered.
    await expect(page.getByRole('button', { name: /Pick existing/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Upload new/i })).toBeVisible();

    expect(
      consoleWatcher.errors,
      `the signing page logged console errors:\n${consoleWatcher.errors.join('\n')}`,
    ).toEqual([]);
  });

  test('a document can be chosen and all three signer kinds are offered', async ({ page }) => {
    // Something to sign. Any readable document will do — this asserts on the
    // builder, not on a particular document.
    const documents = await apiGet(api, '/documents?take=5');
    test.skip((documents.data ?? []).length === 0, 'no documents exist to build a ceremony against');

    await page.goto('/dashboard/signing');
    await expectPageHealthy(page);

    // Pick the first document in the existing-document list.
    const picker = page.getByPlaceholder(/Search documents/i);
    await expect(picker).toBeVisible();
    await page.locator('button', { hasText: (documents.data[0].documentName ?? documents.data[0].title) as string }).first().click();

    // 1. A NAMED internal signer — searched tenant-wide, deliberately not
    //    department-filtered, so a cross-department signatory is reachable.
    await expect(page.getByPlaceholder(/Search users by name or email/i)).toBeVisible();

    // 2. A ROLE signer — nobody specific yet; every holder in the department is
    //    notified and the first to open it claims the signature.
    await expect(page.getByRole('button', { name: /Add role signer/i })).toBeVisible();

    // 3. An EXTERNAL signer — someone with no account at all.
    await expect(page.getByRole('button', { name: /Add external signer/i })).toBeVisible();
  });

  test('adding an external signer produces editable name and email fields', async ({ page }) => {
    const documents = await apiGet(api, '/documents?take=5');
    test.skip((documents.data ?? []).length === 0, 'no documents exist to build a ceremony against');

    await page.goto('/dashboard/signing');
    await expectPageHealthy(page);
    await page.locator('button', { hasText: (documents.data[0].documentName ?? documents.data[0].title) as string }).first().click();

    await page.getByRole('button', { name: /Add external signer/i }).click();

    // An external signer is identified only by what is typed here — there is no
    // account to fall back on, so both fields have to be present and editable.
    await expect(page.getByPlaceholder(/External signer name/i)).toBeEditable();
    await expect(page.getByPlaceholder(/email@example.com/i)).toBeEditable();
  });

  test('a role signer is added as a role, not resolved to one person', async ({ page }) => {
    const documents = await apiGet(api, '/documents?take=5');
    test.skip((documents.data ?? []).length === 0, 'no documents exist to build a ceremony against');

    await page.goto('/dashboard/signing');
    await expectPageHealthy(page);
    await page.locator('button', { hasText: (documents.data[0].documentName ?? documents.data[0].title) as string }).first().click();

    // The button is deliberately disabled until a role is actually chosen —
    // "add role signer" with no role would create an unassignable recipient.
    const rolePicker = page.locator('select').filter({ hasText: /assign by role/i }).first();
    const roleOptions = await rolePicker.locator('option').all();
    const role = await roleOptions[1]!.getAttribute('value');
    expect(role, 'no assignable roles were offered').toBeTruthy();
    await rolePicker.selectOption(role!);

    await page.getByRole('button', { name: /Add role signer/i }).click();

    // The recipient must stay a ROLE. Resolving it to a named person at
    // add-time would defeat the point: the request is unclaimed until whoever
    // holds the role opens it, and it is department-scoped at claim time.
    await expect(page.getByText(/^Role: /).first()).toBeVisible();
  });
});
