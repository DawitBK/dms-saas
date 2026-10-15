import { test, expect, expectPageHealthy } from './fixtures/app';
import { TINY_PDF } from './fixtures/api';

/**
 * Interface and database saying the same thing (2026-10-11).
 *   - the search page's classification filter offers exactly the four classes a document can hold (it used to offer OPEN, SECRET and
 *     TOP_SECRET, which match nothing, and leave out PUBLIC and RESTRICTED);
 *   - the upload form's inputs stop at the length of the column they are saved in.
 * The values come from the database CHECK on documents.security_classification, not from a copy in this file.
 */
test.describe('classification and field lengths', () => {
  test('the search filter offers exactly the four classes, in words, with the stored values', async ({ page }) => {
    await page.goto('/dashboard/search');
    await expectPageHealthy(page);
    const filters = page.getByRole('button', { name: /filter/i }).first();
    if (await filters.isVisible().catch(() => false)) await filters.click().catch(() => null);
    const select = page.locator('select').filter({ has: page.locator('option[value="RESTRICTED"]') }).first();
    await expect(select).toBeAttached();
    const options = await select.locator('option').evaluateAll((els) => els.map((e) => ({ value: (e as HTMLOptionElement).value, label: e.textContent?.trim() })));
    expect(options).toEqual([
      { value: '', label: 'All' },
      { value: 'PUBLIC', label: 'Public' },
      { value: 'INTERNAL', label: 'Internal' },
      { value: 'CONFIDENTIAL', label: 'Confidential' },
      { value: 'RESTRICTED', label: 'Restricted' },
    ]);
    for (const stale of ['OPEN', 'SECRET', 'TOP_SECRET']) await expect(select.locator(`option[value="${stale}"]`)).toHaveCount(0);
  });

  test('the upload form stops geographic scope and external reference at their column lengths', async ({ page }) => {
    await page.goto('/dashboard/upload');
    await expectPageHealthy(page);
    // the details step (where these fields are) opens once a file is chosen
    await page.locator('input[type="file"]').setInputFiles({ name: 'limits.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    await page.getByRole('button', { name: 'Next Step' }).first().click();
    await expect(page.locator('input[name="geographicScope"]')).toHaveAttribute('maxlength', '100');
    await expect(page.locator('input[name="externalReference"]')).toHaveAttribute('maxlength', '200');
  });
});
