# DMS Verification Test Scripts

Live verification scripts that exercise the running backend over HTTP (plus a couple that talk to the DB directly). They complement the Jest suite (`npm test`) by proving end-to-end behavior against a real server.

## Prerequisites

1. **Database:** PostgreSQL running with all migrations applied (`npm run db:migrate`)
2. **Seed Data:** the practice workspace (`npm run db:seed:qa`: tenant `qa-lab`, personas `qa.<key>@qa.local`, development database only). The older `verify-*.ts` scripts no longer need the demo seed or `admin@edams.local`: they sign in through `lib/dev-admin.ts` as `qa.sysadmin@qa.local` in `qa-lab` (override with `VERIFY_ADMIN_EMAIL`, `VERIFY_TENANT`, and `VERIFY_APPROVER_EMAIL` for the second person who decides approval steps), translate the demo role names (`manager@`, `ops.manager@`, `hr.manager@`, `employee@`, `approver@`, `officer@edams.local`) to their QA equivalents, and refuse any target that is not the local development backend (exit 2). Sign-in is the passwordless dev login, so `LOCAL_JWT_MOCK=true` must be set in `.env.development` (set it back afterwards). A script that needs data the practice workspace does not have prints one `NEEDS DEMO DATA` line and exits 3 (for example `verify-phase2-tenancy.ts` needs an account in two or more tenants: `VERIFY_MULTITENANT_EMAIL`)
3. **Backend:** Running on `http://localhost:7100` (`npm run dev`)

## Script Inventory

| Script | What it proves | Transport |
| --- | --- | --- |
| `verify-cams.ts` | Full CAMS correspondence lifecycle — 27 checks incl. gap-free reference allocation and the double-approval concurrency race | Live HTTP `:7100` |
| `verify-audit-atomicity.ts` | 8 checks — awaited audit writes commit atomically with their domain change; hash chain stays valid | Live HTTP `:7100` |
| `verify-runtime-flows.ts` | 38+ checks — MFA single-use/lockout, restore-over-quota 413, trash-voids-e-sign, deactivation sweep (+ fault-injected savepoint containment), AI consent gate, SLA breach → EMAIL outbox PROCESSED | Live HTTP `:7100` + DB + Redis |
| `verify-rls-tus-webhook.ts` | RLS rehearsal loose ends as `edams_app`: tus resumable upload end-to-end under RLS, outbox webhook dispatch with tenant-scoped subscriber lookup, GUC-less negative control | Live HTTP `:14100` (rehearsal stack) + DB |
| `verify-phase1-permissions.ts` | Multi-role permission resolution, deterministic permissions, JWT structure | Live HTTP (two-phase auth: login → select-tenant) |
| `verify-phase2-tenancy.ts` / `verify-phase2.ts` | Tenant selection flow, cross-tenant isolation, single-tenant bypass | Live HTTP (two-phase auth) |
| `verify-phase3-hierarchy.ts` | Department nesting/tree, cycle detection, folder hierarchy | Live HTTP (two-phase auth) |
| `verify-bulk-operations.ts` | Bulk document operations | Live HTTP |
| `verify-comments.ts` | Document comments | Live HTTP |
| `verify-email-templates.ts` | Template-registry rendering | Direct |
| `verify-reports.ts` | Reports endpoints | Live HTTP |
| `verify-webhook-dispatch.ts` | Webhook outbox fan-out + HMAC signing | Live HTTP |
| `verify-tenant-scoping.ts` | 13 checks — users list/read joined to `user_tenants`, so a tenant admin cannot see or probe another tenant's users (R-06) | Direct (service layer) |
| `verify-session-revocation.ts` | 16 checks — revocation cutoffs durable in Postgres, atomic with the permission change that caused them, monotonic (R-04) | Direct (service layer) |
| `verify-audit-chain-sharding.ts` | 8 checks — sharded audit hash chain: concurrent audited writes no longer serialise per tenant, chain stays verifiable, tampering still detected (R-02) | Direct (service layer) |
| `verify-load-safety.ts` | 21 checks — per-request transaction bounds actually applied and actually reset; Socket.IO answers on the path the browser asks for and offers a WebSocket upgrade; unauthenticated handshakes refused; /operations/health collapses a burst onto one probe (R-01 + F-06) | Direct (DB) + live HTTP `:7100` |
| `verify-assignment-selection.ts` | 35 checks — approval/signatory assignee selection and role-queue staffing | Direct (service layer) |
| `verify-approval-participant-access.ts` | 11 checks — a named approval assignee outside the item's department can actually OPEN their work: the engine grants participants a `document:read` ACL entry at submit/reassign/auditor-assignment, and the ACL cache is invalidated on commit so the grant takes effect immediately rather than after its 300s TTL | Live HTTP `:7100` |
| `verify-forms-approval-selection.ts` | 26 checks — the form submitter chooses who approves: the prefill resolves the chain recipe from the FORM TEMPLATE (an instance has no id until it is filed), a chosen chain survives the fill pipeline into the database intact, omitting one preserves the old default, a cross-department named approver can open the filed document, and every bad chain is refused before anything is filed | Live HTTP `:7100` |
| `verify-letter-signature-on-record.ts` | 14 checks — the numbered letter of record actually carries the signature captured by the e-signing ceremony (it used to render none: the PDF generator accepted a signature image and never drew it, and was fed the always-empty profile signature rather than the ceremony's), with a typed-signature control proving no image is invented | Live HTTP `:7100` |
| `verify-outbox-abandoned-sweep.ts` | 9 checks — outbox rows abandoned in PROCESSING with no retries left get a terminal state instead of sitting "in flight" forever (the claim query's `attempts < max_attempts` guard makes them invisible to its own reclaim branch), while still-retryable and genuinely in-flight rows are left alone | Direct (DB) |
| `verify-form-reference-numbers.ts` | 13 checks — an approved form gets REF/UNIT/DEPT/FORM/YEAR/NNNNN from a gap-free per-unit-per-year counter, allocated at FINAL APPROVAL (not at submit, which would burn a number on every declined form), consecutive, idempotent, and in its own series so it can never consume a number from the correspondence register | Live HTTP `:7100` |
| `verify-email-and-workers.ts` | 6 checks — Redis is up and all 11 BullMQ queues reachable, the SMTP relay authenticates, `sendEmail()` delivers, the outbox EMAIL channel processes end to end, the dedupe guard suppresses a redelivery but only after a real send, and the EMAILS worker consumes a job. **Sends real email** — set `EMAIL_REDIRECT_TO` first | Direct (DB + Redis + SMTP) |
| `verify-outbox-expiry-and-prune.ts` | 16 checks — stale WEBSOCKET/EMAIL/WEBHOOK events are retired instead of being relayed in bulk when a transport recovers, events inside their window survive, delivered history and old dead letters are pruned, and **OCR/SEARCH_INDEX are never expired or pruned** (they are durable work orders — expiring one leaves a document silently unsearchable) | Direct (DB) |
| `verify-antivirus.ts` | 7 checks — clamd is reachable and a clean buffer scans `clean` rather than `unscanned`, EICAR is detected, an infected upload is refused by `POST /documents` with 422, and a clean upload still succeeds and records `avScanStatus='clean'`. Refuses to run with `CLAMAV_ENABLED=false` rather than report a false green | Live HTTP `:7100` + clamd |
| `retire-stale-email-backlog.ts` | Maintenance, not a verifier. Gives a stale EMAIL backlog a terminal state so it cannot be relayed in bulk the next time SMTP works. Dry run by default; refuses production without an explicit flag | Direct (DB) |
| `run-all-verifications.ts` | Meta-runner for the phase scripts | — |

> Naming note: the `verify-phase1/2/3` scripts kept their legacy names from an older
> verification plan, but they speak the **current two-phase auth contract**
> (login → select-tenant → full token).

## Running

```bash
# Individual scripts
npx tsx test-scripts/verify-cams.ts
npx tsx test-scripts/verify-audit-atomicity.ts

# Phase scripts via npm
npm run verify:phase1
npm run verify:phase2
npm run verify:phase3
npm run verify:all      # meta-runner
```

Each script prints per-check pass/fail, a summary, and exits 0 (success) / 1 (failure).

## Environment Variables

```bash
export API_URL=http://localhost:7100/api/v1   # only needed for a non-default port
```

## Troubleshooting

- **Connection refused** — backend not running (`npm run dev`) or not on `:7100`.
- **User not found / NEEDS DEMO DATA** — run `npm run db:seed:qa` for the practice workspace, or point `VERIFY_ADMIN_EMAIL` / `VERIFY_TENANT` at an account and tenant that exist.
- **Migration not applied** — `npm run db:migrate`; check with `npm run db:migrate:status`.
- **Tenant not found** — verify seed created the tenants and `user_tenants` rows.

## Test Data Cleanup

Scripts create temporary data (users, departments, folders, letters):

```bash
npm run db:seed:reset   # resets DB and re-seeds
```
