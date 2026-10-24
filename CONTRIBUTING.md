# Contributing to DMS

Enterprise document & archive management system. Shares one contribution convention
with its two sibling systems, SSO and GMS — an engineer moving between the three
repos should not have to relearn how branches, commits, or PRs work in each one.

## Branching

- `main` is always deployable. Never commit directly to it.
- Branch off `main` using `<type>/<short-description>`, where `<type>` is one of:
  `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Example: `fix/folder-mutation-envelope`.
- Keep branches scoped to one change — DMS's compliance posture (ISO 15489, MoReq2010,
  ISO 27001, Exampleland's Electronic Signature Proclamation 1072/2018) depends on being
  able to reason about exactly what one change touched.

## Commits

- Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>: <summary>`,
  e.g. `fix: wrap folder mutation routes in the shared {data} envelope`.
- Explain *why* in the body when the reason isn't obvious from the diff.
- Reference the relevant platform gap-register entry (kept in the SSO edition; e.g.
  `PLATFORM-GAP-006`) when a commit closes or touches one.

## Before opening a PR

Run what CI runs, locally, first:

```bash
npm install
npm run typecheck
npm --workspace backend run lint
npm --workspace frontend run lint
npm test
npm run build
```

If your change affects the test count or coverage, run `npm run test:status` and
commit the resulting `Documentations/TEST_STATUS.md` diff — CI fails the build if
this file is stale relative to the actual test run.

For changes touching migrations, ACL/permission logic, or the approval/signing
engine, also run the live verifiers before opening the PR:

```bash
cd backend
npx tsx test-scripts/test-acl-ancestry.ts
npx tsx test-scripts/verify-cams.ts          # 27 checks
npx tsx test-scripts/verify-audit-atomicity.ts  # 8 checks
```

## Pull requests

- Use the PR template (`.github/pull_request_template.md`).
- CI (`.github/workflows/ci.yml`) must pass before merge: typecheck, lint (both
  workspaces), `npm audit`, test suite, the TEST_STATUS.md drift check, build, and a
  separate DB-backed integration job.
- Squash-merge by default, so `main`'s history stays one commit per logical change.

## Scope discipline (Directive §8)

DMS is part of a three-system platform whose architecture decisions are recorded in
`SSO/docs/platform/`. One rule governs every contribution here: treat DMS's existing
business logic (document lifecycle, ACL/folder
permission model, workflow engine, RAG pipeline, search, real-time collaboration) as
correct and intentional. Don't change functional behavior as a side effect of a
structural change unless the PR description says so explicitly and why.

## Where things live

- `README.md` — how to run it, how it is configured, what it does.
- `ARCHITECTURE.md` — the architecture reference; `Documentations/DMS-MASTER_DOC.md` is the deep-dive.
- `SYSTEM-DECISIONS.md` — authoritative for the approval engine (decisions D1–D14,
  cited by number from `modules/approvals/` and six database models).
- The 2026-07-26 and 2026-09-03 audits are closed; their reports are not part of this edition, and source comments cite their
  findings by date and number.
- `CHANGELOG.md` — what shipped, in Keep-a-Changelog format. `Documentations/rollout.md` — how to
  ship it without breaking live users.
- `Documentations/` — BRD/FRD/TDD/implementation-plan/governance specs and the
  deployment runbooks.
