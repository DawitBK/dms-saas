import { test, expect, expectPageHealthy, watchConsole } from './fixtures/app';

/**
 * Every route the four modules live on must actually MOUNT.
 *
 * This is the cheapest possible guard against the failure that cost the most
 * time on 2026-09-03: a corrupted `.next` left the signing page throwing
 * `sendWithPromise of null` on mount. The API was perfectly healthy —
 * verify-cams passed 38/38 the whole time — so nothing in the existing test
 * suites could see it. A page that renders is a precondition for every other
 * spec here.
 *
 * One test per route rather than a loop, deliberately: the dev server compiles
 * each route on first visit, so a loop spends its whole budget on the first few
 * and then reports a timeout that names the wrong page.
 *
 * Each route is identified by its own PageHeader <h1> (level 1, specifically),
 * not by any text on the page. Two things make a loose match useless here: the
 * sidebar carries a nav link for most of these ("My Work", "Documents", …) and
 * stays in the DOM while collapsed, so a text match resolves to a HIDDEN
 * sidebar item; and TopBar renders the SAME title again as an <h2>, so an
 * unleveled heading match is ambiguous. The dashboard is the one page with no
 * PageHeader at all — TopBar suppresses its own title when breadcrumbs are
 * supplied — so it is identified by its first metric card instead.
 */

const ROUTES: Array<{ path: string; name: string; heading?: RegExp; text?: string }> = [
  { path: '/dashboard', name: 'Dashboard', text: 'Total Documents' },
  { path: '/dashboard/documents', name: 'Documents (DMS core)', heading: /^All Documents$/i },
  { path: '/dashboard/letters', name: 'Letters (CAMS)', heading: /^Correspondence$/i },
  { path: '/dashboard/forms/templates', name: 'Form templates', heading: /^Form Templates$/i },
  { path: '/dashboard/forms/fill', name: 'Fill a form', heading: /^Fill a Form$/i },
  { path: '/dashboard/forms/submissions', name: 'Form submissions', heading: /^My Submissions$/i },
  { path: '/dashboard/signing', name: 'E-signing', heading: /^E-signing$/i },
  { path: '/dashboard/mywork', name: 'My Work (approvals queue)', heading: /^My Work$/i },
];

test.describe('smoke: every module route mounts', () => {
  for (const route of ROUTES) {
    test(`${route.name} renders without a client-side crash`, async ({ page }) => {
      const consoleWatcher = watchConsole(page);

      await page.goto(route.path);

      // A route-level auth guard bouncing us to /login is a failure of this
      // test, not a reason to skip it.
      await expect(page, `${route.path} redirected to login`).not.toHaveURL(/\/login/);

      await expectPageHealthy(page);
      const marker = route.heading
        ? page.getByRole('heading', { level: 1, name: route.heading })
        : page.getByText(route.text!, { exact: true }).first();
      await expect(marker).toBeVisible();

      // The pdf.js worker failure that broke signing surfaced ONLY as a console
      // error — the page shell rendered fine — so a visible-content assertion
      // alone would have missed it entirely.
      expect(
        consoleWatcher.errors,
        `${route.name} logged console errors:\n${consoleWatcher.errors.join('\n')}`,
      ).toEqual([]);
    });
  }
});
