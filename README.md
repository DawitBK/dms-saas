# DMS — Enterprise Document & Archive Management System

> **Stack:** Next.js 16 (App Router, Turbopack, React 19) · Express 5 · TypeScript · Sequelize 6 + PostgreSQL · Redis + BullMQ · Socket.IO · MinIO · Meilisearch
> **Ports:** backend `7100`, frontend `7101` — the same in development and production.

DMS is a multi-tenant document and records management platform built as a modular
monolith. It manages the full lifecycle of an enterprise document: capture,
classification, versioning, approval, digital signing, archive, retention, legal
hold and certified disposal — plus CAMS, the correspondence (incoming/outgoing
letter) module built on top of it.

It is one of three systems on the Example Corp platform (with GMS and SSO). See the
repository root's `CLAUDE.md` and `/DEPLOYMENT-GUIDE.md` for the platform view.

**Documentation:** start at [`Documentations/README.md`](Documentations/README.md), the index: reading order, a by-task table, and where the audits, runbooks, user guides and old specs are.

---

## Quick start

```bash
# 1 — Infrastructure: PostgreSQL, Redis, MinIO, Meilisearch, MailHog, ClamAV
docker compose -f docker-compose.dev.yml up -d

# 2 — Install once, from the repo root (this is an npm workspaces repo)
npm install

# 3 — Database, then the backend API + queue worker  ->  http://localhost:7100
cd backend
cp .env.example .env          # then fill in the secrets it names
npm run db:setup              # migrate + seed
npm run dev                   # starts the API and the BullMQ worker together

# 4 — Frontend  ->  http://localhost:7101
cd ../frontend
cp .env.development.example .env.development
npm run dev
```

Health check: `GET http://localhost:7100/health`.
API docs (Swagger) at `http://localhost:7100/api-docs` when `ENABLE_API_DOCS=true`
— which must be `false` in production and staging.

The backend boots and degrades gracefully when MinIO or Meilisearch are down: it
falls back to local-disk storage and PostgreSQL `ILIKE` search. That is convenient
and also a trap — a dev box with a misconfigured `MINIO_ENDPOINT` never exercises
the real storage path at all. `backend/.env.example` documents why every host in it
is `127.0.0.1` rather than `localhost`.

---

## Configuration

| File | When it is read |
|---|---|
| `backend/.env` | Development only. **Never read when `NODE_ENV=production`.** |
| `backend/.env.production` | Production only. Mandatory — a missing file is a hard refusal to start, not a fallback. |
| `frontend/.env.development` | Development only. Next reads it only when `NODE_ENV=development`, so it cannot reach a production build. |
| `frontend/.env.production` | Production build values. |
| `frontend/.env.local` | **Do not create one.** Next loads `.env.local` in *both* modes and ranks it above `.env.production`, so a dev value here silently bakes `localhost` into the production bundle. The build refuses when it detects this. |

`backend/.env.example` and `frontend/.env.development.example` are the authoritative
lists of every variable, each carrying the reasoning for its value. To see what
production config actually resolves to, without starting anything:

```bash
cd backend && npm run env:verify:prod
```

Two subsystems are optional, and their credentials are required only when selected:
`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` when `STORAGE_DRIVER=minio`, and
`MEILISEARCH_HOST`/`MEILISEARCH_MASTER_KEY` when `SEARCH_ENGINE=meilisearch`.

---

## Seeding

Three seeds, and the difference matters:

| Command | What it writes | Safe in production |
|---|---|---|
| `npm run db:seed:reference` | Tenant, 7 roles, org units, departments, document types, retention policies, folder tree, default workflow | **Yes** — this is the production seed |
| `npm run db:seed:core` | Everything above **plus** 17 demo `@edams.local` users, a second fake `demo-org` tenant, and demo documents | No — bootstrap/demo only |
| `npm run db:seed:reset` | Truncates, then re-runs `db:seed:core` | No |

Each has a `:prod` variant that loads `.env.production` (`db:seed:reference:prod`,
`db:seed:core:prod`). On a real deployment you want `db:seed:reference:prod`.

Demo accounts (from `db:seed:core`, all in the `examplecorp` tenant): `admin@`,
`manager@`, `officer@`, `approver@`, `employee@`, `auditor@`, `chief@` plus
per-department variants, all `@edams.local`. Passwords are bypassed in development
(`LOCAL_JWT_MOCK=true`) and the login page offers them as quick-pick buttons.

---

## Authentication

**Two-phase tenant selection.** `POST /auth/login` returns a tenant-less token plus
the caller's tenant list; `POST /auth/select-tenant` exchanges it for the full
access token. Every verifier and integration test speaks this contract.

**Revocation fails closed in production.** If Redis is unavailable DMS returns
`503 ERR-AUTH-REVOCATION-UNAVAILABLE` rather than honouring a token whose logout,
disablement or IdP back-channel revocation it cannot verify. Run Redis highly
available and alert on that code. Development and test keep the fail-open path so
isolated tests need no external infrastructure.

**SSO.** DMS is a real OIDC client of the platform's identity provider (client id
`edams`): `GET /auth/oidc/authorize` -> IdP -> `POST /auth/callback`, which verifies
the id_token against the IdP's JWKS, requires `email_verified === true`, validates
the Redis-stored `nonce` (failing closed with 503 if Redis is down), then
JIT-provisions the user. Roles come from the `ad_groups`/`edams_roles` claims via
the `idp_role_mappings` table, per relying party; only an unmatched user falls back
to `EMPLOYEE`. `OIDC_SCOPES` must request `ad_groups` and `edams_roles` explicitly —
they are no longer inside `profile`, and omitting them silently flattens every
first-time SSO user to `EMPLOYEE`.

---

## Authorization model

DMS uses a **two-layer permission + ACL model**. It does not define a fixed
enterprise role taxonomy.

- **Layer 1 — global.** Every endpoint declares a permission string.
  `requirePermission()` resolves it against DB-backed `role_permissions`, with a
  static fallback in `config/permissions.ts`. Unknown roles get zero permissions.
- **Layer 2 — resource ACL.** `resolveACL()` evaluates `acl_entries` and
  `access_rules` for the specific document or folder, DENY-first, walking folder and
  department ancestry. A DENY at any level wins regardless of Layer 1.

The seeded role names are a reference configuration, not architectural constants.
Application logic, routing and UI never string-match a role name — the frontend
gates on `can(permission)` and `<PermissionGate permission="...">`.

---

## What it does

Document lifecycle across 17 states; versioning (checkout/checkin/rollback, plus a
word-level version diff); a unified approval engine shared by documents, form
templates and form instances; electronic and PKI signing; PAdES-signed flattened
PDF copies; an OCR pipeline (Tesseract, with pdfjs text extraction for digital PDFs
and node-canvas rasterization for scans); Meilisearch full-text search with a
PostgreSQL fallback; retention policies with certified disposal; legal hold;
warm/cold/WORM archive tiers; an immutable hash-chained audit log; real-time
notifications over Socket.IO; HMAC-signed outbound webhooks; ClamAV scanning;
resumable tus uploads; TOTP 2FA; compliance reports; bulk operations; an opt-in,
vendor-neutral AI assistant; and Prometheus metrics.

**CAMS** adds correspondence: outgoing letters with a maker–checker–approver chain,
gap-free reference numbers (`REF/UNIT/DEPT/TYPE/YEAR/SEQ`) allocated only at final
approval, letterhead PDFs carrying a QR code, public QR verification at `/verify`
with no login, incoming letter registration, cross-reference threading, dispatch
and delivery tracking, and org units (HQ / branches / outlets / sister companies).

`ARCHITECTURE.md` is the architecture reference; `Documentations/DMS-MASTER_DOC.md` is the deep-dive;
`SYSTEM-DECISIONS.md` is authoritative for the approval engine's design (D1–D14).

---

## Repository layout

```
DMS/
├── backend/
│   ├── src/
│   │   ├── api/v1/          route composition (public, protected, internal)
│   │   ├── modules/         33 domain modules (documents, approvals, letters, forms, ...)
│   │   ├── infrastructure/  database, storage, search, queue, email, vault, cache
│   │   ├── shared/          middleware, transactions, ACL resolution
│   │   └── config/          env schema + permission catalogue
│   ├── migrations/          105 forward SQL migrations, each with a .down.sql
│   ├── scripts/             operational scripts (migrate, seed, backup, rewrap-deks, ...)
│   ├── test-scripts/        live-DB / live-HTTP verifiers
│   └── tests/               Jest unit + integration suites
├── frontend/
│   ├── app/                 Next.js App Router pages
│   ├── features/            domain modules (hooks, types, components)
│   ├── shared/              shared components, hooks, lib
│   └── state/               Zustand stores
├── e2e/                     Playwright specs
├── deploy/                  Caddy, Postgres init, backup sidecar
├── Documentations/          specs (BRD/FRD/TDD) and deployment runbooks
└── tools/                   generators (governance workbook, test status)
```

---

## Testing

```bash
npm test                             # backend Jest suites (from the repo root)
npm --workspace frontend run test    # frontend Vitest
npm run e2e                          # Playwright, against running dev servers
npm run typecheck                    # both workspaces
```

The live verifiers in `backend/test-scripts/` run against a *running* backend and a
real database — they are how behaviour unit tests cannot reach gets proven. Start
with `backend/test-scripts/README.md`; `npm run verify:all` runs the suite.

`Documentations/DMS_E2E_Test_Guide.xlsx` is the manual end-to-end retest checklist (26 sheets, 252
cases) covering setup, auth, the permission matrix, ACL, multi-tenancy, lifecycle,
versioning, search, workflow/SLA, retention, signing, forms, OCR/AI, audit,
realtime, webhooks, rate limiting, reports and bulk operations.

---

## Deployment

The live deployment is native (no Docker), behind the shared Apache reverse proxy at
`https://portal.examplecorp.com/dms`. The platform runbook is `/DEPLOYMENT-GUIDE.md`
at the repository root.

This repo also carries a self-contained Docker Compose stack for standalone
deployment — `docker-compose.prod.yml` + `.env.prod.example` + `deploy/` (Caddy,
Postgres init that creates the `edams_app` role, backup sidecar). Its runbooks are
`Documentations/DEPLOY-COMPOSE.md`, `DEPLOY-WINDOWS-MANUAL.md`
and `DR-RUNBOOK.md`.

`Documentations/rollout.md` covers shipping changes safely once real users depend on the system:
expand/contract migrations, feature flags, and what counts as a breaking change.

---

## License

Proprietary — Example Corp Operations. All rights reserved.
