import { test, expect, expectPageHealthy, watchConsole } from './fixtures/app';
import { apiGet, apiLogin, createDraftDocument, type ApiSession } from './fixtures/api';

let api: ApiSession;

test.beforeAll(async () => {
  api = await apiLogin();
});

async function selectFirstRealOption(select: import('@playwright/test').Locator) {
  const value = await select.locator('option').evaluateAll((options) =>
    options.map((option) => option.getAttribute('value')).find((candidate) => candidate),
  );
  if (!value) throw new Error('expected a selectable option');
  await select.selectOption(value);
}

test('bulk-selected documents compile into one visible, owned document in selection order', async ({ page }) => {
  const marker = `E2E bundle ${Date.now()}`;
  const titles = [`${marker} first`, `${marker} second`, `${marker} third`];
  const sources = [] as Array<{ id: string; title: string }>;
  for (const title of titles) {
    sources.push(await createDraftDocument(api, { title }));
  }

  const consoleWatcher = watchConsole(page);
  await page.goto('/dashboard/files');
  await expectPageHealthy(page);

  // Selection is deliberately driven through My Files, the workflow reported
  // as silently dropping documents. The server independently validates every
  // selected id before it creates the bundle.
  for (const title of titles) {
    await page.getByRole('checkbox', { name: `Select ${title}` }).check();
  }
  await page.getByRole('button', { name: 'Bundle', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'New bundle' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder(/Q3 Procurement Package/i).fill(marker);
  await dialog.getByRole('button', { name: /Create bundle/i }).click();
  await page.waitForURL(/\/dashboard\/bundles\/[0-9a-f-]+$/i);

  // The detail page is the authoritative visible order, not a client-side
  // count. Every selected item must arrive and retain its selection position.
  for (const [index, title] of titles.entries()) {
    await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
    await expect(page.getByLabel(`Position ${index + 1}`)).toBeVisible();
  }

  const bundleId = page.url().split('/').at(-1)!;
  const compileResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/bundles/${bundleId}/compile`) && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Compile \(3\)/ }).click();
  expect((await compileResponse).status()).toBeLessThan(400);
  await expect(page.getByText('Compiled document ready')).toBeVisible();

  const compiledLink = page.getByRole('link', { name: /Open document/i });
  await expect(compiledLink).toBeVisible();
  const compiledHref = await compiledLink.getAttribute('href');
  expect(compiledHref).toMatch(/^\/dashboard\/documents\/[0-9a-f-]+$/i);
  const compiledId = compiledHref!.split('/').at(-1)!;

  const bundle = (await apiGet(api, `/bundles/${bundleId}`)).data;
  expect(bundle.status).toBe('COMPILED');
  expect(bundle.compiledDocumentId).toBe(compiledId);
  expect(bundle.items.map((item: { documentId: string }) => item.documentId)).toEqual(sources.map((source) => source.id));

  // A compiled bundle is a normal owner-visible document, not merely a bundle
  // record. Assert both client surfaces and the API used by their queries.
  const myFilesResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/documents') && url.searchParams.get('ownerId') === api.user.id;
  });
  await page.goto('/dashboard/files');
  const myFilesPayload = await (await myFilesResponse).json();
  expect(myFilesPayload.data.some((document: { id: string }) => document.id === compiledId)).toBe(true);
  await expect(page.locator(`a[href="/dashboard/documents/${compiledId}"]`).first()).toBeVisible();
  const mine = await apiGet(api, `/documents?ownerId=${api.user.id}&take=100`);
  expect(mine.data.some((document: { id: string }) => document.id === compiledId)).toBe(true);

  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: marker, exact: true })).toBeVisible();
  expect(consoleWatcher.errors, consoleWatcher.errors.join('\n')).toEqual([]);
});

test('a multi-file upload can proceed directly into the same bundle workflow', async ({ page }) => {
  const marker = `E2E uploaded bundle ${Date.now()}`;
  const tinyPdf = Buffer.from(
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

  await page.goto('/dashboard/upload');
  await expectPageHealthy(page);
  await page.locator('input[type="file"]').setInputFiles([
    { name: `${marker} one.pdf`, mimeType: 'application/pdf', buffer: tinyPdf },
    { name: `${marker} two.pdf`, mimeType: 'application/pdf', buffer: tinyPdf },
  ]);
  await page.getByRole('button', { name: /Next Step/i }).click();

  // Lookups are loaded asynchronously. Target the semantic form names rather
  // than the incidental visual order of every select (org unit, classification,
  // language, and folder are all selects too), and wait until the actual
  // selectable data has arrived before driving the dependent type picker.
  const department = page.locator('select[name="departmentId"]');
  await expect(department.locator('option:not([value=""])').first()).toBeAttached();
  await selectFirstRealOption(department);
  const documentType = page.locator('select[name="documentTypeCode"]');
  await expect(documentType.locator('option:not([value=""])').first()).toBeAttached();
  await selectFirstRealOption(documentType);
  await page.locator('textarea[name="description"]').fill('Two uploaded files compiled by the E2E workflow.');
  await page.locator('input[name="keywords"]').fill('e2e, bundle');
  await page.getByRole('button', { name: /Next Step/i }).click();

  // This action is intentionally on the review step, before any upload has
  // happened. It must upload all selected files and then open the shared bundle
  // dialog with the successful document ids.
  await expect(page.getByRole('button', { name: /Upload & bundle/i })).toBeVisible();
  await page.getByRole('button', { name: /Upload & bundle/i }).click();
  const dialog = page.getByRole('dialog', { name: 'New bundle' });
  await expect(dialog).toBeVisible({ timeout: 120_000 });
  await dialog.getByPlaceholder(/Q3 Procurement Package/i).fill(marker);
  await dialog.getByRole('button', { name: /Create bundle/i }).click();
  await page.waitForURL(/\/dashboard\/bundles\/[0-9a-f-]+$/i);

  await expect(page.getByRole('link', { name: `${marker} one`, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `${marker} two`, exact: true })).toBeVisible();
});
