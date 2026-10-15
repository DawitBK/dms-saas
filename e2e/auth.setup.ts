import { test as setup } from '@playwright/test';
import { signIn, expect } from './fixtures/app';
import { AUTH_STATE } from '../playwright.config';

/**
 * Drive the real login once and save the session for every other spec.
 *
 * This is also the only place the two-phase auth contract (login →
 * select-tenant → full token) is exercised through the UI, so a regression
 * there fails the entire run at its first step rather than surfacing as eight
 * confusing per-spec failures.
 */
setup('sign in and cache the session', async ({ page }) => {
  await signIn(page);

  // The session lives in localStorage under 'edash-auth'; assert it is really
  // there before saving, or every dependent spec starts unauthenticated and
  // fails for a reason that has nothing to do with what it tests.
  const stored = await page.evaluate(() => window.localStorage.getItem('edams-auth'));
  expect(stored, 'the persisted session was not written to localStorage').toBeTruthy();

  await page.context().storageState({ path: AUTH_STATE });
});
