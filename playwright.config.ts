import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/** Where the signed-in session is cached between the setup project and the
 *  specs. Gitignored — it holds a real access token. */
export const AUTH_STATE = path.join(__dirname, 'e2e', '.auth', 'admin.json');

/**
 * End-to-end tests that drive the real UI in a real browser.
 *
 * These exist because the unit tests and the `test-scripts/verify-*.ts`
 * verifiers both stop at the API boundary. Every bug reported against this
 * system in the 2026-09-03 cycle lived past that boundary: a form whose
 * approver picker did not exist, a letters dialog that fused "submit for
 * approval" with "who signs it", a signing page that failed to mount. An API
 * that answers correctly proves nothing about whether anyone can reach it.
 *
 * They run against the DEV servers already running on :7100/:7101, and against
 * the dev database — deliberately, because that is the environment the bugs
 * were reported in. `webServer` is therefore NOT configured to start them:
 * starting Next's dev server on a `.next` that a production build has touched
 * is what corrupted the client mid-session once already. Start the app
 * yourself, then run these.
 *
 *   Terminal 1:  cd backend  && npm run dev     # :7100
 *   Terminal 2:  cd frontend && npm run dev     # :7101
 *   Terminal 3:  npx playwright test
 *
 * Single worker on purpose. These tests file real documents, letters and forms
 * into a shared database and several assert on "the newest item", which is not
 * a safe assumption if two specs are filing at once.
 */
export default defineConfig({
  testDir: './e2e',
  // Generous: the dev server compiles each route on first visit, and a cold
  // /dashboard/signing (pdf.js + its worker) is genuinely slow the first time.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    // localhost, NOT 127.0.0.1: the backend's CORS allow-list is a single
    // exact origin (CLIENT_URL=http://localhost:7101), and the two spellings
    // are different origins to a browser. Driving the app from 127.0.0.1 makes
    // every API call fail preflight with a bare "Failed to fetch" that looks
    // like the app is broken.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:7101',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    // Sign in ONCE and save the session, rather than driving the login form at
    // the head of every spec. The dev server compiles each route on first
    // visit, so the specs are already slow enough without paying for a fresh
    // two-phase login each time. The login flow itself is still exercised —
    // that is what this project does, and every other project depends on it,
    // so a broken login fails the whole run rather than being skipped.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: AUTH_STATE,
      },
    },
  ],
});
