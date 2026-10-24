# DMS documents

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 1 | [../README.md](../README.md) | Run, configure, seed, sign in; what DMS does; repository layout; testing; deployment |
| 3 | [../ARCHITECTURE.md](../ARCHITECTURE.md) | The architecture reference |
| 4 | [../DMS-MASTER_DOC.md](DMS-MASTER_DOC.md) | The deep dive. *`Documentations/DMS-MASTER_DOC.html` is older than the `.md`; the page says so* |
| 5 | [../SYSTEM-DECISIONS.md](../SYSTEM-DECISIONS.md) | Decisions D1–D14; authoritative for the approval engine. Code cites the numbers, so they never change |

## By task

| I want to… | Open |
|---|---|
| ship a change without breaking live users | [../rollout.md](rollout.md) |
| see what changed and when | [../CHANGELOG.md](../CHANGELOG.md) |
| deploy natively on Windows | [DEPLOY-WINDOWS-MANUAL.md](DEPLOY-WINDOWS-MANUAL.md), [DEPLOY-WINDOWS-AUTOMATION.md](DEPLOY-WINDOWS-AUTOMATION.md) (the release runner it describes is platform tooling, not part of this repository) |
| deploy with Docker Compose | [DEPLOY-COMPOSE.md](DEPLOY-COMPOSE.md), [CONTAINER-IMAGE-PINNING.md](CONTAINER-IMAGE-PINNING.md) |
| recover from a disaster, or run the restore drill | [DR-RUNBOOK.md](DR-RUNBOOK.md) |
| know how users, roles, status and email stay consistent between SSO and DMS, and who wins a conflict | [SSO-DMS-SYNC-AND-CONFLICT-RULES.md](SSO-DMS-SYNC-AND-CONFLICT-RULES.md) |
| know who can create departments, folders, document types and assign roles, and where each role's authority stops | [ROLE-SCOPE-MATRIX.md](ROLE-SCOPE-MATRIX.md) |
| understand encryption and file storage | [DMS-ENCRYPTION-STORAGE-GUIDE.md](DMS-ENCRYPTION-STORAGE-GUIDE.md) |
| harden TLS | [TLS-HARDENING-APPLY.md](TLS-HARDENING-APPLY.md) |
| know the test-coverage rule | [TEST-COVERAGE-POLICY-2026-09-18.md](TEST-COVERAGE-POLICY-2026-09-18.md) |
| contribute | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| run the end-to-end tests | [../e2e/README.md](../e2e/README.md) |
| read the user guides | [user-guides/dms-user-manual.html](user-guides/dms-user-manual.html), [user-guides/forms-user-guide.html](user-guides/forms-user-guide.html) (summer 2026; check against the current screens) |

## Audits

The audit reports themselves (2026-07-26, 2026-09-03 and 2026-09-18) are not part of this edition. Source comments and migrations cite their findings by date and number (for example `R-04`, `#9`, `TEST-1`); the code and the documents listed above describe the resulting behaviour.

## In this folder

| Item | What it is |
|---|---|
| `TEST_STATUS.md` | **Generated**; CI fails if it is out of date. Don't edit or move it |
| [UI-BACKEND-PARITY-SWEEP-2026-09-18.md](UI-BACKEND-PARITY-SWEEP-2026-09-18.md) | A point-in-time sweep |
| `user-guides/` | The two HTML user guides |
| [DMS-PROCESS-FLOW-ONE-PAGE.html](DMS-PROCESS-FLOW-ONE-PAGE.html) | The document process flow on one printable A4 landscape page (moved here on 2026-10-17) |

[← DMS README](../README.md)
