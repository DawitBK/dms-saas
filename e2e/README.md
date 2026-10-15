# End-to-end tests

Playwright specs that drive the real UI in a real browser, across all four
modules: **documents (DMS core)**, **forms**, **letters (CAMS)** and
**e-signing**.

## Why these exist

The unit tests (`backend/tests`, `frontend/*.test.ts`) and the live verifiers
(`backend/test-scripts/verify-*.ts`) both stop at the API boundary. Every bug
reported against this system in the 2026-09-03 cycle lived *past* that boundary:

| Reported symptom | What the API tests said |
|---|---|
| "Initiate signing does nothing" | `verify-cams` 38/38 — the whole letter + e-signing lifecycle was healthy. A corrupted `.next` left the signing page throwing `sendWithPromise of null` on mount. |
| "Forms auto-assign approvers; I can't pick anyone" | The engine had always accepted author-chosen approvers. The fill dialog simply never sent any. |
| "The signer gets an approval request, not a signature" | Every endpoint behaved as designed. Submit-for-approval and initiate-signing were fused in one dialog. |

An API that answers correctly proves nothing about whether anyone can reach it.

These specs have already earned their place: `forms.spec.ts` caught the fill
dialog resolving role holders **tenant-wide** while the engine scopes them to the
form's own department, so the picker reported every role as staffed everywhere.
The author picked one, the PDF rendered, the instance was filed — and only then
did the engine refuse the chain with `ERR-STEP-ROLE-UNSTAFFED`, leaving a filed
form with no approval chain and no way to add one. The unit tests and the live
verifier both passed throughout, because both happened to choose a department
where the role was staffed.

## Running them

The specs run against the **dev servers you start yourself**, and against the dev
database. `webServer` is deliberately *not* configured: starting Next's dev
server on a `.next` that a production build has touched is what corrupted the
client mid-session once already, and this suite must never be the thing that
does it.

```bash
# Terminal 1
cd backend  && npm run dev      # :7100

# Terminal 2
cd frontend && npm run dev      # :7101

# Terminal 3
npm run e2e                     # from DMS/
npm run e2e:ui                  # interactive
npx playwright test e2e/forms.spec.ts -g "chain the submitter builds"
```

First run only: `npx playwright install chromium`.

### Required: raise the API rate limit

The authenticated v1 API caps one user at `RATE_LIMIT_USER_PER_MINUTE` requests
(default **100**), and the suite shares that budget with the browser it is
driving. Thirty page-driving tests legitimately exceed what any human generates,
so without this the run fails with a cascade of `ERR-RATE-LIMIT` 429s that look
like application failures.

```dotenv
# backend/.env — development only
RATE_LIMIT_USER_PER_MINUTE=1000
```

Leave it at the default in production. That cap is what stops a single caller
consuming the shared concurrency allowance (see the admission-control note in
`backend/src/api/v1/index.ts`).

## How they are built

- **`fixtures/app.ts`** — `signIn` drives the real dev login form and the tenant
  picker rather than injecting a token, because a token shortcut would have
  passed happily through every failure above. `watchConsole` collects console
  errors, which is how the pdf.js failure presented: the shell rendered fine.
- **`auth.setup.ts`** — signs in once and caches the session; every other project
  depends on it, so a broken login fails the whole run at its first step.
- **`fixtures/api.ts`** — provisioning only, never assertions *about* the UI. It
  puts the system into the state a test needs (an active form template, an
  approved letter, a draft document) and reads back what a click actually wrote,
  which is the half a UI assertion cannot see: a picker can look perfect and post
  nothing. Reference data is memoized per run — refetching it per test spent the
  shared request budget on data that never changes.
- **Single worker.** These file real documents, letters and forms into a shared
  database. Tests capture the response of their *own* submission rather than
  reading "the newest row", but ordering assumptions across parallel workers
  would still be unsound.

## Conventions worth keeping

- **Assert on a page's own `<h1>`, not on text.** The sidebar carries a nav link
  for most routes and stays in the DOM while collapsed, so a loose text match
  resolves to a *hidden* sidebar item and proves nothing. `TopBar` also repeats
  the title as an `<h2>`, so match `{ level: 1 }`.
- **Never use `isVisible()` as a guard.** It is an immediate check with no retry,
  so on a page still loading it silently skips the test — the exact failure a
  skip is meant to prevent. Use `expect(...).toBeVisible()`.
- **Provision, don't discover.** A spec that skips when no draft happens to exist
  goes quiet precisely when a regression would ship.
- **Wait for the data, not just the element.** Async-loaded pickers render their
  container before their contents; interacting in that window fails as "step 0
  not found", which reads like the feature is missing rather than like a race.
- **`localhost`, not `127.0.0.1`.** The backend's CORS allow-list is one exact
  origin (`CLIENT_URL=http://localhost:7101`), and to a browser the two spellings
  are different origins — every API call fails preflight with a bare
  "Failed to fetch" that looks like the app is broken.

## What they leave behind

Each run files real rows into the dev database: form templates named
`E2E … <timestamp>`, letters subject-prefixed `E2E `, and one uploaded document
per run. That is deliberate — asserting against real persisted state is the
point — but the dev database accumulates them, so clear them out periodically
with `npm run db:seed:reset` if the fixtures get noisy.
