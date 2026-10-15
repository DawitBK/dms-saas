import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared E2E helpers.
 *
 * Sign-in drives the real UI — the dev login form, then the tenant picker —
 * rather than injecting a token into localStorage. That is the point: a token
 * shortcut would have passed happily through every one of the failures this
 * suite exists to catch, because all of them were on the far side of a page
 * actually rendering.
 */

export const DEMO = {
  // The QA tenant ("qa-lab") built by backend `npm run db:seed:qa`. The old demo accounts no longer exist on dev.
  admin: 'qa.sysadmin@qa.local',
  manager: 'qa.fin.head@qa.local',
  approver: 'qa.fin.approver@qa.local',
  officer: 'qa.records@qa.local',
  chief: 'qa.exec@qa.local',
} as const;

/** Sign in through the dev login form and land on the dashboard. */
export async function signIn(page: Page, email: string = DEMO.admin): Promise<void> {
  await page.goto('/login');

  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Two-phase auth: a user in more than one tenant is sent to the tenant
  // picker first. A single-tenant user skips straight to the dashboard, so
  // this branch has to be tolerated rather than awaited.
  await page.waitForURL(/\/(dashboard|select-tenant|select-role)/, { timeout: 60_000 });

  if (page.url().includes('/select-tenant')) {
    await page.getByRole('button', { name: /qa laboratory|qa-lab|examplecorp/i }).first().click();
    await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 60_000 });
  }
  if (page.url().includes('/select-role')) {
    await page.getByRole('button').first().click();
    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  }

  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Assert a page rendered its own content rather than an error boundary.
 *
 * The single most damaging failure of the 2026-09-03 cycle was a page that
 * mounted and then threw (`sendWithPromise of null` on the signing page, from a
 * corrupted `.next`), which no API-level test could see. Every spec calls this
 * so a blank or crashed route fails loudly instead of letting a later
 * `toBeVisible` time out with a misleading message.
 */
export async function expectPageHealthy(page: Page): Promise<void> {
  // Next.js dev overlays and React error boundaries both surface these.
  const fatal = page.locator('text=/Unhandled Runtime Error|Application error: a client-side exception|Internal Server Error/i');
  await expect(fatal).toHaveCount(0);
  await expect(page.locator('body')).not.toBeEmpty();
}

/** Console errors collected for the current test, so a spec can assert a page
 *  is not merely visible but actually clean. */
export type ConsoleWatcher = { errors: string[] };

export function watchConsole(page: Page): ConsoleWatcher {
  const watcher: ConsoleWatcher = { errors: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Noise that says nothing about the page under test: this dev environment
    // deliberately runs without Redis/MinIO/Meilisearch (the backend degrades
    // to in-memory cache, local disk and ILIKE search by design), and the dev
    // server's own HMR/websocket chatter is not application behaviour.
    if (/favicon|ERR_CONNECTION_REFUSED|_next\/static\/chunks\/app-pages-internals|Download the React DevTools|hot-reloader|websocket|HMR/i.test(text)) return;
    watcher.errors.push(text);
  });
  page.on('pageerror', (err) => watcher.errors.push(`pageerror: ${err.message}`));
  return watcher;
}

export const test = base;
export { expect };
