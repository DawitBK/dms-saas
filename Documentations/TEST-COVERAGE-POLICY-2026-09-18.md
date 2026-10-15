# TEST-3 coverage policy

## What changed

The backend now measures coverage in the standard test command used by CI and
enforces a non-regression floor in `backend/jest.config.cjs`:

| Metric | Enforced minimum | Measured baseline |
| --- | ---: | ---: |
| Statements | 37% | 37.80% |
| Branches | 19% | 20.07% |
| Functions | 23% | 24.54% |
| Lines | 39% | 39.43% |

The threshold is intentionally a ratchet, not an artificial declaration that
the entire system is well-covered. It prevents silent regression while each
complex module is expanded with focused tests. The values must only move up.

## New direct coverage

- `reports.service.test.ts`: report registry, unknown-report rejection,
  tenant-bound query substitutions, date ranges, summaries and CSV output.
- `tenants.service.test.ts`: membership-scoped tenant visibility and the
  intentional platform-admin bypass.
- `users.departmentAssignment.test.ts`: transaction-bound department grant,
  audit event and post-commit cache invalidation.
- `featureFlags.service.test.ts`: cached/default-deny flags, missing tenant,
  name validation, transactional update, audit, and post-commit invalidation.

The audit’s retention, legal-hold, rate-limit, and trash/hold coverage remains
in place. Five previously script-scoped test files were made TypeScript modules
with `export {}` so coverage compilation cannot merge top-level mocks across
test files.

## Verification

`npm --workspace backend run test:coverage -- --runInBand` passes with 60
suites and 543 tests, as measured on 2026-09-18 (see `Documentations/TEST_STATUS.md` for the current live count, which has since grown). Coverage artifacts (`lcov.info` and JSON summary) are
already uploaded by `.github/workflows/ci.yml`.

