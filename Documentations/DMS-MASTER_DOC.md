# DMS — Master System Documentation

**Status:** canonical, authoritative reference for the DMS (Document & Archive Management System / "EDAMS") codebase as it exists in this working copy.
**Scope:** DMS only. SSO and GMS are separate systems documented separately.
**Method:** every claim below was traced to source (file:line citations throughout) — the backend route files, models, config schema, migrations, worker files and deploy runbooks — not copied from prose docs without verification. Where existing docs (`ARCHITECTURE.md`, `SYSTEM-DECISIONS.md`, `README.md`, `Documentations/rollout.md`, `CHANGELOG.md`, `dms-docs.html`) already had accurate canonical content, it is incorporated and cross-referenced rather than re-derived from scratch.
**Do not** read this as a second, competing doc — it replaced `dms-docs.html` as the deep-dive entry point (that file was deleted on 2026-09-06 — dated July, it still documented the pre-migration ports 3000/4000). The per-file canonical docs (`ARCHITECTURE.md`, `SYSTEM-DECISIONS.md`, `README.md`) remain authoritative for their own narrow scope and are cited throughout; this document's job is to be the single place that connects all of them into one operable picture.

Legend used throughout: **[V]** verified directly against source in this session. **[CFG]** configuration/deployment-dependent (behavior changes with an env var or selected backend). **[GAP]** a documented, known limitation — not a bug, a stated scope boundary.

---

## 1. Executive System Overview

### 1.1 What DMS is

DMS ("Document Management System", internally and in ~19 database/token identifiers still called **EDAMS** — see §33.1 for why that name persists) is a multi-tenant **document and records management platform** built as a modular monolith. It is one of three systems on the Example Corp internal platform (with GMS and SSO), sharing one internal server and one identity provider, but is fully self-contained: its own database (`dmsprod`), its own document store, its own approval/workflow engine. [V — `README.md`]

It manages the complete lifecycle of an enterprise document — capture, classification, versioning, approval, digital signing, archive, retention, legal hold, and certified disposal — plus **CAMS**, a correspondence (incoming/outgoing letter) module built on top of the same document substrate.

### 1.2 Why it exists / business purpose

Example Corp needed a records-management system that could:
- Replace ad hoc paper/email-based document handling with an auditable, permissioned digital repository, satisfying records-management (MoReq2010-influenced) expectations: retention schedules, legal hold, certified destruction, immutable audit trail.
- Formalize approval workflows for both generic documents/forms and outbound/inbound correspondence (CAMS), with a company-mandated maker–checker–approver discipline that individual departments cannot bypass.
- Provide legally meaningful electronic signing (e-signing ceremonies, with a parked PKI/PAdES upgrade path) rather than "type your name at the bottom".
- Do this multi-tenant from day one — a single tenant, `examplecorp`, but structured internally as a "Group" of sister companies (`org_units`: HQ / branches / outlets / sister companies) sharing one system with siloed archive scoping. [V — `ARCHITECTURE.md` "CAMS" section]

### 1.3 Core capabilities (verified, current implementation)

| Capability | Verified detail |
|---|---|
| Document lifecycle | 17 states, explicit transition graph — §10, `backend/src/modules/documents/DocumentStateMachine.ts` |
| Versioning | Checkout/checkin, immutable version history, rollback, word-level version diff (`GET /documents/:id/versions/diff`) |
| Unified approval engine | Chain templates with locked/unlocked steps, sequential decisioning, audit stage, per-type signing policy — `modules/approvals/`, SYSTEM-DECISIONS.md D1–D8 |
| CAMS correspondence | Outgoing/incoming letters, maker–checker–approver chain, gap-free reference numbers, QR public verification, cross-reference threading — `modules/letters/` |
| E-signing | Serial/parallel multi-recipient ceremonies, internal + external (access-token) signers, PAdES-signed flattened copies on completion — `modules/esigning/` |
| Forms engine | State-guarded templates (`draft→pending_approval→active→deprecated`), pdfme-rendered instances filed as first-class Documents — `modules/forms/` |
| OCR | Tesseract.js + pdfjs-dist text-layer extraction for digital PDFs, `@napi-rs/canvas` rasterization for scans — `OCRWorker` |
| Search | Meilisearch **[CFG]** with PostgreSQL ILIKE fallback — `modules/search/` |
| Storage | MinIO **[CFG]** with local-disk fallback — `infrastructure/storage/` |
| Retention & disposal | Policy-driven retention, two-stage purge (trash → 7-day cooling → certified destruction), maker–checker on manual purges |
| Legal hold | Freeze mechanism; the *only* freeze mechanism (SYSTEM-DECISIONS.md D11 — no separate "administrative hold") |
| Audit | Immutable, HMAC-signed, hash-chained `audit_logs`, sharded per-tenant for concurrency (`AUDIT_CHAIN_SHARDS`) |
| Notifications | Socket.IO realtime + in-app `notifications` table, fanned out via the transactional outbox |
| Webhooks | HMAC-SHA256-signed outbound HTTP callbacks, tenant-scoped, per-subscription isolation |
| AI assistant | Opt-in per tenant (feature flag), provider-agnostic (Groq/OpenAI/Anthropic/custom), tool-use chat over documents + audit log; on-demand summarize/extract |
| 2FA | TOTP (otplib) |
| Compliance reporting | Registry of tenant-scoped reports, JSON/CSV export |
| Bulk operations | Multi-document bulk actions with 207 multi-status responses |
| Resumable uploads | tus protocol for >25MB files |
| Antivirus | ClamAV scanning **[CFG — `CLAMAV_ENABLED`]** |
| Metrics | Prometheus (`prom-client`), authenticated `/api/v1/metrics` + optional public `/metrics` |

### 1.4 Major users / roles

Seven seeded roles (a *reference configuration*, not an architectural constant — see §8): `SYSTEM_ADMIN`, `RECORDS_OFFICER`, `DEPT_MANAGER`, `APPROVER`, `EMPLOYEE`, `AUDITOR`, `EXECUTIVE`. [V — `backend/src/config/permissions.ts`]

### 1.5 System boundaries and dependencies

- **Owns:** its own PostgreSQL database (`dmsprod`/`DMS` dev), its own document blob store (local disk or MinIO), its own Redis-backed queues/caches/rate limits, its own Socket.IO realtime layer.
- **Depends on (required):** PostgreSQL 15+/16, Redis ≥ 6.2 (hard version-checked at boot, `assertRedisVersion`).
- **Depends on (optional, degrades gracefully):** MinIO (→ local disk), Meilisearch (→ Postgres ILIKE), ClamAV (→ uploads recorded unscanned), an AI provider (→ AI routes return 403 until a tenant opts in).
- **External systems:** the platform SSO/IdP (real OIDC relying party, client id `edams`) for production login; an LLM provider for the AI assistant (opt-in, provider-agnostic).
- **Does NOT integrate with:** `retail-os`, `carrier-os` (explicitly standalone); MRS (retired 2026-09-04).

### 1.6 Current deployment model

**Reference production deployment (the Example Corp internal server)**: **native** (no Docker), in the install folder (for example `C:\apps\dms`), backend on loopback `127.0.0.1:7100`, frontend on `127.0.0.1:7101`, reverse-proxied by the shared Apache instance at `https://portal.examplecorp.com/dms` (and `/dms/api/v1`). Three separate console-window processes: API, BullMQ worker, frontend — split deliberately after a 2026-08-28 incident where a native segfault inside a PDF-OCR rasterization library took the whole API process down mid-request. Database `dmsprod` lives on the same shared Postgres instance as `gmsprod`/`idpprod`. See §23 for the full procedure. [V — `Documentations/DEPLOY-WINDOWS-MANUAL.md`]

A self-contained Docker Compose stack (`docker-compose.prod.yml` + `.env.prod.example` + `deploy/`) is also carried in-repo as a supported *alternate* path (VPS/standalone use), but is **not** what the Example Corp server runs. Do not conflate the two when reasoning about "is Docker the problem" — on this server, Docker is not involved in DMS at all.

### 1.7 Current infrastructure constraints (verified, current)

- Single Postgres instance shared across GMS/DMS/SSO (`max_connections=100` verified against live `pg_stat_activity`; DMS alone is configured for `DB_POOL_MAX=60`).
- Single-instance deployment (no horizontal scaling yet) — the codebase carries multi-instance-*readiness* primitives (Redis-backed rate limiting, Socket.IO Redis adapter, configurable pool, graceful drain) but nothing currently runs a second instance. **[GAP]**
- MinIO/Meilisearch are genuinely absent on the production server today — it runs local-disk storage + Postgres ILIKE search in production, by deliberate choice (see §32.2).
- No PgBouncer in front of Postgres on this deployment (documented as a possible-but-limited future lever — see the `DB_POOL_MAX` comment in `config/env.ts`, §22).

---

## 2. Complete Architecture

### 2.1 Request path — browser to database

```
Browser (Next.js SSR/CSR, port 7101 dev / behind Apache /dms in prod)
   │  fetch via apiClient (axios) → NEXT_PUBLIC_API_BASE_URL
   ▼
Apache reverse proxy (prod only) — /dms → 127.0.0.1:7101, /dms/api/v1 → 127.0.0.1:7100/api/v1
   ▼
Express app (backend/src/app.ts), in order:
   1. trust-proxy config (TRUST_PROXY=loopback)
   2. helmet (CSP off only when ENABLE_API_DOCS)
   3. cors (CORS_ORIGINS / CLIENT_URL allowlist, credentials:true)
   4. compression, cookie-parser
   5. requestIdMiddleware, requestLogger, metricsMiddleware
   6. IP-based rate limiters: /api/v1/auth (20/min), /api/v1/documents/upload (10/min), /api (800/min)
   7. tus resumable-upload handler (mounted BEFORE express.json — raw body)
   8. express.json({limit:'50mb'}), express.urlencoded
   9. /health, /.well-known/jwks.json (unauthenticated, always-on)
  10. cacheControl (per-path Cache-Control headers)
  11. app.use(API_BASE_PATH, v1Routes)          ← /api/v1/*
  12. errorHandler (last)
   ▼
v1Routes (api/v1/index.ts): public router (/auth, esigningPublicRoutes, lettersPublicRoutes,
   /operations, /internal/roles) vs protectedRoutes (authenticate → userRateLimiter →
   admissionControl → tenantContext → 30 module routers)
   ▼
Module router → requirePermission()/requireAnyPermission() → requireACL() where resource-scoped
   → asyncHandler(controller) → *.service.ts (business logic)
   ▼
Sequelize models (infrastructure/database/models/) — one pooled connection per request,
   held for the FULL request lifetime (tenantContext opens a real transaction so RLS's
   SET LOCAL app.current_tenant works — see §22/§26)
   ▼
PostgreSQL (dmsprod) — row-level security enforced under the edams_app role in production
```

Side effects (email, websocket push, webhook fan-out, OCR trigger, search indexing) are **never** performed inline in the request — they are written to `outbox_events` in the *same* transaction as the domain change, then dispatched by a 5-second poller. See §2.6.

### 2.2 Frontend architecture

Next.js 16 (App Router, Turbopack, React 19), TypeScript, Tailwind CSS. State: Zustand for auth/UI (persisted to `localStorage["dms-auth"]`), TanStack Query for all server data. All backend calls go through `NEXT_PUBLIC_API_BASE_URL` (`http://localhost:7100/api/v1` dev) via a shared `apiClient` (axios) that attaches the Bearer token and implements a 401→refresh→retry interceptor. See §20 for the full page/feature map.

### 2.3 Backend architecture

Express 5 + TypeScript, ESM (`"type": "module"` in `package.json` — every internal import uses explicit `.js` extensions, a Node ESM requirement, not a typo). Layering: `api/v1` (route composition) → `modules/*` (domain: routes → service → occasionally a narrower sub-service) → `infrastructure/*` (database, storage, search, queue, email, vault, cache, websocket, antivirus) → `shared/*` (middleware, transaction helper, ACL resolver, auth) → `config/*` (env schema, permission catalogue). See §3 for the full directory map.

### 2.4 API layer

Everything hangs off `/api/v1` (`API_BASE_PATH`, configurable but never actually changed). Two sibling routers: a **public** one (no `authenticate`) for `/auth/*`, `/operations/*` (health is public; the rest re-gate behind `authenticate` internally), the external e-signing endpoints, and the CAMS public QR-verify route; and a **protected** one carrying everything else behind `authenticate → userRateLimiter → admissionControl → tenantContext`. A third, entirely separate auth path exists for `/internal/roles/*` — the SSO admin console's back-channel into DMS's role/permission tables, gated by a shared secret (`DMS_INTERNAL_API_KEY`) and an IP allowlist, not a user JWT at all. See §6 for the full endpoint reference and §7 for the auth chain.

### 2.5 Service layer

Each module's `*.service.ts` holds the actual business logic — validation, state-machine enforcement, DB writes, audit-log emission, outbox-event enqueueing. Routes are transport-only (parse request → call service → shape response); this is stated explicitly as a rule for the auth module's file header and is the consistent style across the whole codebase.

### 2.6 Data layer — transactions and the transactional outbox

Two load-bearing conventions, both non-obvious and both explained in the codebase's own comments (`ARCHITECTURE.md`):

1. **`runInTransaction()`** (`shared/transaction.ts`) is the *only* correct way to open a transaction inside a request. Sequelize 6's CLS (continuation-local storage) integration does **not** make the managed-callback form (`sequelize.transaction(async t => ...)`) join an already-open ambient transaction as a savepoint — it only auto-injects the ambient transaction into individual *queries* that omit an explicit `{transaction}` option. Every `writeAuditLog` call and ~30 other service call sites used the managed-callback form before this was understood, silently opening a second, non-atomic connection per call. `runInTransaction()` reuses the request's already-open transaction (opened by `tenantContext`) when one exists, and falls back to a real `sequelize.transaction()` outside a request (workers, scripts). Anything that must run only *after* the surrounding transaction actually commits (ACL cache invalidation, irreversible storage deletes) uses `transaction.afterCommit(() => ...)` — **never** code placed textually after the `runInTransaction()` call returns, because with a reused ambient transaction the real commit happens later, at HTTP response-finish time. `tests/auditAtomicity.test.ts` pins this guarantee down.
2. **Transactional outbox** (`infrastructure/queue/outbox.ts`): side effects are written to `outbox_events` in the same DB transaction as the domain change, then dispatched by a 5-second poller. Channels: `WEBSOCKET`, `EMAIL`, `WEBHOOK`, `OCR`, `SEARCH_INDEX`. At-least-once delivery, `attempts < maxAttempts` (3), exponential backoff. Per-channel max-age before an event is abandoned: `OUTBOX_EMAIL_MAX_AGE_HOURS` (default 72h) for EMAIL/WEBHOOK; WEBSOCKET is deliberately much shorter (a stale realtime push is worthless); OCR/SEARCH_INDEX never expire. **Critical ordering rule**: EMAIL/WEBSOCKET dedupe guards and WEBHOOK fan-out dedupe are claimed only *after* the side effect actually succeeds, never before — claiming first and only then attempting delivery would turn a transient failure into silent, permanent loss (at-least-once degrading to at-most-once).

### 2.7 Storage, search, OCR, e-signing, notifications, SSO — see dedicated sections

Full detail in §13 (search), §14 (storage), §15 (OCR), §16 (PDF), §17 (e-signing), §18 (notifications), §7 (auth/SSO).

### 2.8 Reverse proxy / routing (production)

Apache is the single public entry point (80/443). Path-based routing: `/dms` → `127.0.0.1:7101` (frontend), `/dms/api/v1` → `127.0.0.1:7100/api/v1` (backend), `/dms/socket.io/` → the backend's Socket.IO listener (prefixed — an unprefixed `/socket.io/` on this server belongs to GMS). `Upgrade`/`Connection` headers must be forwarded on the API location or Socket.IO silently degrades to long-polling. See §23.

### 2.9 Runtime processes (production)

Three OS processes, not one: **API** (`node dist/src/main.js` via `npm run start:prod`, reads `.env.production`, serves HTTP + Socket.IO + the outbox poller), **worker** (`node dist/scripts/... ` /`npm run worker:prod`, runs the 15 BullMQ workers — see §19), **frontend** (`next start` via the standalone-build launcher). In production `ENABLE_QUEUE_WORKERS=false` and `ENABLE_OUTBOX_POLLING=false` are set in the API process's env so the worker process is the *only* place BullMQ workers actually run — this split exists specifically so a worker-side native crash (e.g. inside PDF/OCR rasterization) cannot take down live API traffic.

### 2.10 Inter-process communication

- API ↔ worker: exclusively through Postgres (`outbox_events`, domain tables) and Redis (BullMQ queues, caches, rate-limit counters, ACL cache). No direct RPC between the two processes.
- API ↔ browser: HTTP/JSON + Socket.IO (realtime notification push, tenant/department-scoped rooms).
- DMS ↔ SSO: two channels — (a) DMS as a real OIDC relying party calling out to SSO's IdP endpoints at login (§7.3); (b) SSO calling *into* DMS's `/internal/roles/*` API to manage role/permission mappings on behalf of an SSO admin (§6.9).

---

## 3. Repository and Codebase Map

Root: `DMS/` (own git repo, remote `github.com/DawitBK/dms-saas`, checked out as a subfolder of the platform working copy).

| Path | Purpose | Layer | Key files | Rules for modifying |
|---|---|---|---|---|
| `backend/src/api/v1/` | Route composition/mounting only | Backend | `index.ts` | Add a new module's router here; decide public vs protected placement deliberately (see §2.4) |
| `backend/src/app.ts` | Express app assembly: middleware order, CSP, CORS, rate limiters, tus mount, JWKS, cache-control | Backend | `app.ts` | Middleware **order** is load-bearing (trust-proxy before rate limiters; tus before `express.json()`) — never reorder without reading the inline comments first |
| `backend/src/main.ts` / `bin/worker.ts` | Process entrypoints — API process vs worker process | Backend | both | Keep the API/worker split; do not merge them back together (see §2.9) |
| `backend/src/config/` | `env.ts` (Zod-validated env schema + prod boot guards), `permissions.ts` (static role→permission fallback + `PERMISSIONS` catalogue) | Backend/shared | both | New env var: add to schema with a `.default()`/reasoning comment; new permission: add to `PERMISSIONS` + at least one role in `ROLE_PERMISSIONS` |
| `backend/src/core/` | `AppError`, `logger` (pino); `asyncHandler` lives in `backend/src/shared/` | Backend shared | — | Cross-cutting; stable, rarely touched |
| `backend/src/infrastructure/database/models/` | One Sequelize model file per table (63 models) | Backend/data | `index.ts`, `associations.ts` | **Import from `index.ts`/`associations.ts`, never a bare model file** — association wiring only runs once, at `initModels()` |
| `backend/src/infrastructure/database/sequelize.ts` | Singleton Sequelize instance, pool config | Backend/data | — | Pool size (`DB_POOL_MAX`) is a real concurrency ceiling — see §22 |
| `backend/src/infrastructure/queue/` | BullMQ workers (15), the transactional outbox poller, queue registration | Backend/infra | `outbox.ts`, `queues.ts`, `workers/*.ts` | New async side effect → new outbox channel + worker, not an inline call from a request handler |
| `backend/src/infrastructure/storage/` | `StorageAdapter` interface, `local.ts`, `minio.ts`, `index.ts` (driver selection) | Backend/infra | — | New storage backend: implement `StorageAdapter`, wire into `index.ts`'s switch on `STORAGE_DRIVER` |
| `backend/src/infrastructure/search/` | `meilisearch.ts` (client + health probe + tenant-index management) | Backend/infra | — | Postgres ILIKE fallback lives in `modules/search/search.service.ts`, not here |
| `backend/src/infrastructure/vault/` | `VaultService.ts` (env-key KEK wrapping), `HashiCorpVaultService.ts` (Transit engine), `kekSelfTest.ts` | Backend/infra | — | Never touch DEK-wrapping logic without reading the "Encryption & Key Rotation" section of `ARCHITECTURE.md` first |
| `backend/src/infrastructure/email/` | `mailer.ts` (nodemailer wrapper), `templates.ts` (`renderEmail(type,payload)` registry) | Backend/infra | — | **Never hand-build email HTML/text inline** — add a template to the registry |
| `backend/src/infrastructure/websocket/` | `socket.ts` (Socket.IO server + Redis adapter), `gateway.ts` | Backend/infra | — | — |
| `backend/src/infrastructure/antivirus/` | `clamscan.ts` | Backend/infra | — | — |
| `backend/src/infrastructure/cache/` | ACL cache (in-memory LRU+TTL), rate-limit Redis store, status-permission cache | Backend/infra | — | — |
| `backend/src/modules/` | 33 domain modules — see §3.1 table below | Backend/domain | — | Standard shape per module: `*.routes.ts` (transport only), `*.service.ts` (logic), sometimes a narrower sub-service file |
| `backend/src/shared/` | `auth.ts` (JWT decode, `requirePermission`/`requireAnyPermission`), `resolveACL.ts` (DENY-first ACL engine + `requireACL`/`assertACLAllow`), `middleware.ts` (`tenantContext`, `admissionControl`, error handler), `transaction.ts` (`runInTransaction`, `runInSavepoint`), `internalAuth.ts`, `idempotency.middleware.ts`, `workerTenantContext.ts` | Backend shared | — | Cross-module contracts — changing these affects every module |
| `backend/migrations/` | 97 forward SQL migrations, each with a paired `.down.sql`, tracked in `SequelizeMeta` (Umzug) | Backend/data | — | New schema change = new numbered migration + down file; see `Documentations/rollout.md` for expand/contract discipline |
| `backend/scripts/` | **Operating** the system: migrate, seed, backup, key-rotation, storage reconciliation | Backend/ops | see §24 | Never put a verifier here — that's `test-scripts/` |
| `backend/test-scripts/` | **Proving** the system works: live-HTTP/live-DB verifiers | Backend/tests | `README.md` | — |
| `backend/tests/` | Jest unit + integration suites (52 suites / 478 tests) | Backend/tests | — | — |
| `backend/docs/` | OpenAPI spec served at `/api-docs` when `ENABLE_API_DOCS=true` | Backend/docs | `api/openapi.yaml` | Must be `false` in production/staging (boot guard enforces it) |
| `backend/assets/` | Fonts (Noto Sans Ethiopic, OFL) for Amharic PDF rendering | Backend/assets | — | Shipped in the Docker image and copied on native deploys |
| `frontend/app/` | Next.js App Router pages | Frontend | see §20 | — |
| `frontend/features/` | Domain modules: hooks, types, components, one per business area (18 dirs) | Frontend | see §20 | — |
| `frontend/shared/` | `DataTable`, `Modal`, `PermissionGate`, `TopBar`, `Sidebar`, `TenantSwitcher`, `apiClient`, `permissions.ts`, `cn` | Frontend shared | — | — |
| `frontend/state/` | Zustand stores: `auth.store.ts`, `ui.store.ts` | Frontend | — | — |
| `e2e/` | Playwright specs (5 files) + fixtures | Tests | `playwright.config.ts` | — |
| `deploy/` | Caddy config, Postgres-init role script, backup sidecar scripts, Prometheus config — for the **Docker Compose** path only | Infra (Docker path) | — | Not used by the native production deployment |
| `Documentations/` | BRD/FRD/TDD specs (.docx), deployment runbooks, `TEST_STATUS.md` | Docs | see §23 | — |
| `tools/` | `audit-gate.mjs` (CI security gate), `generate-test-status.mjs`, `create-dms-governance-workbook.mjs` | Tooling | — | — |
| `vendor/` | `xlsx-0.20.3.tgz` — off-registry, no npm-patched release exists | Dependency | — | Never `npm audit fix --force` this away |

### 3.1 Backend module inventory (33 modules)

| Module | Responsibility | Consumes | Consumed by |
|---|---|---|---|
| `acl` | Per-resource ACL grant/revoke (`acl_entries`) | `resolveACL` engine | documents, folders, workflow_task ACL checks |
| `access-rules` | Tenant-wide / doc-type-scoped ACL grants (`access_rules`), distinct from per-resource ACL | `resolveACL` engine | ACL resolution step 4 |
| `ai` | Chat assistant (tool-use over documents/audit), on-demand summarize/extract | `llmClient.ts`, feature-flags | frontend `dashboard/ai` |
| `approvals` | Unified approval engine (chains, templates, audit stage) | Document/FormTemplate/FormInstance | documents, forms; letters keep their own chain |
| `archive` | (removed — see §33; was a 501 placeholder router) | — | — |
| `assignment-advisory` | Candidate-assignee suggestions | users, departments | approval/letter assignment UIs |
| `audit` | Immutable hash-chained audit log, HMAC-signed | every module (`writeAuditLog`) | compliance reports, `/history` endpoints |
| `auth` | Login, select/switch-tenant, JWKS, OIDC callback, 2FA/TOTP, refresh/revoke | users, roles, Redis | every authenticated request |
| `bundles` | `document_bundles`/`document_bundle_items` — ordered grouping, compile-to-document | documents pipeline | frontend `features/bundles` |
| `comments` | Threaded document comments | documents | frontend `features/comments` |
| `departments` | Nested department tree (ltree), scoped to `org_unit_id` | org-units | folders, users, documents |
| `document-types` | Document type management (drives `reapprovalPolicy`/`auditPolicy`/`signingPolicy`) | — | documents, approvals |
| `documents` | Core CRUD, versioning, checkout/lock, trash/purge, download/preview, signing sub-routes | folders, document-types, storage, vault | almost everything |
| `esigning` | Signature-request envelopes: recipients, fields, serial/parallel, internal + external | documents | frontend signing pages |
| `feature-flags` | Per-tenant boolean flags (e.g. `ai_processing`) | — | ai module gate |
| `folders` | Folder tree (`folder_nodes`), contents listing | departments | documents placement, ACL ancestry walk |
| `forms` | Templates (state-guarded) + instances → pdfme PDF → Document | documents pipeline, approvals | frontend `features/forms` |
| `legal-hold` | Legal hold lifecycle — the sole freeze mechanism | documents | retention/disposal gating |
| `letters` | CAMS correspondence — outgoing/incoming, own approval chain, dispatch, cross-reference | documents (via `documentCrypto`), org-units | frontend `features/letters`, public `/verify` |
| `notifications` | In-app notifications, unread count, Socket.IO push | outbox | frontend notification bell/page |
| `ocr` | (removed — see §33; was a 501 placeholder; real OCR is the `OCR` outbox channel + `OCRWorker`) | — | — |
| `operations` | Health (cached/probed), outbox visibility+retry, crypto-status (KEK rotation), pipeline-metrics | most infra | admin ops panels |
| `org-units` | CAMS archive spaces — HQ/branch/outlet/sister-company, flat under tenant | — | departments, letters reference numbers |
| `reports` | Compliance report registry (JSON/CSV), storage analytics, dashboard aggregate | audit, documents | frontend `features/reports` |
| `retention` | Retention policies, disposal queue, cold-restore | documents, archive | RetentionPurgeWorker |
| `roles` | Role/permission CRUD + internal admin API for SSO | — | every `requirePermission` check (DB-backed override) |
| `search` | Full-text search (Meilisearch + Postgres ILIKE fallback), saved searches | documents, ACL | frontend search page |
| `signing` | Legacy electronic + PKI signing route (kept for back-compat); document-centric routes live in `documents.routes.ts` | documents | frontend signing (legacy path) |
| `tenants` | Tenant CRUD + membership (`user_tenants`) | — | multi-tenancy, admin panels |
| `users` | User management, profile (signature image, notification prefs), department/role assignment | roles, departments | everywhere identity is needed |
| `versions` | (model-level concern; no standalone routes module — see `documents/` version endpoints) | documents | — |
| `webhooks` | Outbound webhook subscription management | outbox (`WEBHOOK` channel) | external consumers |
| `workflow` | Legacy per-document workflow definitions/instances/tasks + SLA engine (distinct from the unified approval engine — both remain live) | documents | frontend Workflow Definitions/Queue panels |

### 3.2 Frontend module inventory

| Feature dir | Purpose |
|---|---|
| `access-control` | `AccessControlCenter` — grant/revoke ACL UI |
| `admin` | CRUD panels: tenants (incl. `TenantMembersModal`), departments, folders, document types |
| `approvals` | Unified approval engine UI (chain stepper, submit modal, My Work) |
| `auth` | Auth store helpers, login/select-tenant hooks |
| `bundles` | `AddToBundleModal`, bundle compile API |
| `comments` | `CommentsPanel` — document threaded comments |
| `documents` | Document hooks/api/types, `VersionDiffModal` |
| `forms` | Templates / Fill / My Submissions |
| `hierarchy` | `HierarchyTreeBrowser` — nested foldable Tenant→OrgUnit→Dept→Folder tree (two mount points: Operations→Hierarchy Browser full-CRUD; Browse-page sidebar select+compact) |
| `legal-hold` | `LegalHoldConsole` |
| `letters` | CAMS API/hooks/types |
| `operations` | `SystemPanels` (incl. `CryptoStatusPanel`), `AuditPanels`, `WorkflowPanels`/`WorkflowDefinitionsPanel`, `RecordsPanels`, `ManagerHub` |
| `reports` | Reports & Analytics dashboard hooks |
| `retention` | `RetentionConsole` — policies, disposal queue, cold restore |
| `roles` | `RoleEditor` |
| `settings` | 2FA, profile, notification prefs |
| `signing` | Electronic/PKI signing API, `SignaturePad`, `PdfFieldPlacer` |
| `users` | `UsersManagementPanel` |

---

## 4. Technology Stack

### 4.1 Backend

| Technology | Version (from `backend/package.json`) | Why | Where |
|---|---|---|---|
| Node.js | 22.x | Runtime; ESM-native | whole backend |
| TypeScript | ^5.6.3 | Type safety across a 33-module monolith | whole backend |
| Express | ^5.2.1 | HTTP framework — v5's native async error propagation removes the need for manual `try/catch` wrapping in most handlers (still wrapped via `asyncHandler` for consistency) | `app.ts`, all routes |
| Sequelize | ^6.37.5 (pinned; **never** `npm audit fix --force` — it would downgrade to v3) | ORM | `infrastructure/database/` |
| pg / pg-hstore | ^8.13.1 / ^2.3.4 | Postgres driver | — |
| Redis (ioredis) | ^5.4.1, server ≥ 6.2 required | Cache, BullMQ backing store, rate-limit store, ACL cache invalidation pub/sub | `infrastructure/cache/`, `infrastructure/queue/` |
| BullMQ | ^5.78.0 | Job queues — 15 named workers | `infrastructure/queue/workers/` |
| Socket.IO (+ redis-adapter) | ^4.8.1 / ^8.3.0 | Realtime push; Redis adapter is multi-instance-ready | `infrastructure/websocket/` |
| MinIO client | ^8.0.7 (pinned — `--force` downgrades to v7) | Object storage driver | `infrastructure/storage/minio.ts` |
| Meilisearch client | ^0.45.0 | Full-text search driver | `infrastructure/search/meilisearch.ts` |
| Zod | ^3.25.76 | Env schema validation, several route body schemas | `config/env.ts` and scattered route validators |
| jsonwebtoken / jwks-rsa | ^9.0.3 / ^4.0.1 | JWT signing/verification, JWKS fetch for SSO | `shared/auth.ts`, `modules/auth/` |
| otplib | ^12.0.1 | TOTP 2FA | `modules/auth/auth.service.ts` |
| tesseract.js | ^5.1.1 | OCR engine | `OCRWorker` |
| pdfjs-dist | ^4.8.69 | Digital-PDF text-layer extraction (exact, no OCR needed) | `OCRWorker` |
| canvas / sharp | ^3.2.3 / ^0.35.4 | Rasterization (scans→images for OCR), image processing | `OCRWorker`, preview generation |
| pdf-lib (+@pdf-lib/fontkit) | ^1.17.1 | Letter/PDF generation, letterhead, QR embedding, Amharic font embedding | `modules/letters/letterPdf.ts` |
| @pdfme/generator, @pdfme/common, @pdfme/schemas | ^6.1.11 | Form-template → PDF rendering | `modules/forms/` |
| @signpdf/* (placeholder-pdf-lib, signer-p12, signpdf) | ^3.3.0 | PAdES byte-range PDF signing for completed e-sign ceremonies | `modules/esigning/esignPades.ts` |
| node-forge | ^1.4.0 | RSA/JWKS key material handling | `app.ts` JWKS endpoint, PKI subsystem |
| @tus/server, @tus/file-store | ^2.4.1 / ^2.1.0 | Resumable upload protocol for >25MB files | `modules/documents/tusUpload.ts` |
| clamscan | ^2.4.0 | ClamAV client | `infrastructure/antivirus/clamscan.ts` |
| qrcode | ^1.5.4 | Letter QR-code generation | `modules/letters/letterPdf.ts` |
| franc | ^6.2.0 | Language detection (OCR pipeline) | `OCRWorker` |
| exceljs | ^4.4.0 (pinned — `--force` downgrades to v3) | Report export | reports module, governance workbook tool |
| docx | ^9.7.1 | Word-document generation | reports/export paths |
| nodemailer | ^10.0.0 | SMTP mail sending | `infrastructure/email/mailer.ts` |
| pino / pino-http / pino-pretty / pino-roll | ^9.14.0 / ^10.3.0 / ^13.1.3 / ^4.0.0 | Structured logging, HTTP request logging, dev pretty-printing, log rotation | `core/logger.ts` |
| prom-client | ^15.1.3 | Prometheus metrics | `infrastructure/metrics.ts` |
| helmet | ^8.0.0 | Security headers, CSP | `app.ts` |
| express-rate-limit | ^7.4.1 | Rate limiting (IP-based + per-user, Redis-backed store) | `app.ts`, `api/v1/index.ts` |
| swagger-ui-express | ^5.0.1 | API docs UI (dev/staging only, never production) | `app.ts` |
| umzug | ^3.8.3 | SQL migration runner | `scripts/migrate.ts` |
| moment / moment-timezone | ^2.30.1 / ^0.5.48 | Business-hours SLA calculation (`BUSINESS_TIMEZONE=UTC`) | approval/workflow SLA workers |
| file-type | ^19.6.0 | Magic-byte MIME sniffing (upload validation, not trusting client-declared type) | upload validation paths |
| @anthropic-ai/sdk | ^0.109.0 | One of several optional LLM providers for the AI module | `modules/ai/llmClient.ts` |

### 4.2 Frontend

| Technology | Version | Why | Where |
|---|---|---|---|
| Next.js | ^16.3.4 (App Router, Turbopack for dev AND build) | React framework | `frontend/app/` |
| React / react-dom | ^19.0.0 | UI | whole frontend |
| TypeScript | ^5.6.3 | Type safety | whole frontend |
| Tailwind CSS | ^3.4.15 | Styling | — |
| @tanstack/react-query | ^5.59.20 | Server-state cache/sync | every `features/*/hooks.ts` |
| zustand | ^4.5.5 | Client state (auth, UI) | `frontend/state/` |
| axios | ^1.18.0 | HTTP client (`apiClient`) | `shared/lib/` |
| socket.io-client | ^4.8.1 | Realtime notifications | notification bell, live pages |
| react-hot-toast | ^2.6.0 | Toast notifications | app-wide |
| react-dropzone | ^15.0.0 | Upload UI | Upload page |
| react-pdf | ^9.2.1 | PDF preview rendering | document preview, signing field placer |
| recharts | ^3.8.1 | Reports/dashboard charts | `features/reports` |
| jspdf / jspdf-autotable | ^4.2.1 / ^5.0.8 | Client-side PDF export (tables/reports) | reports export |
| xlsx | `file:../vendor/xlsx-0.20.3.tgz` (off-registry) | Spreadsheet export/import | reports, bulk import UIs |
| date-fns | ^4.4.0 | Date formatting | app-wide |
| lucide-react | ^0.468.0 | Icon set | app-wide |
| @radix-ui/react-dialog/dropdown-menu/tooltip | ^1.x/^2.x | Accessible UI primitives | `shared/components/Modal`, dropdowns |
| clsx / tailwind-merge | ^2.1.1 / ^3.6.0 | Conditional/merged classnames | `shared/lib/cn` |

### 4.3 Data / infrastructure

| Technology | Version | Role |
|---|---|---|
| PostgreSQL | 15+ (16 in the Docker Compose path) | Primary datastore, row-level security enforced under least-privilege role `edams_app` in production |
| Redis | ≥ 6.2 (hard boot-checked) | BullMQ backing store, rate-limit store, ACL/role/status-permission caches, JWT revocation blacklist, OIDC state/nonce storage |
| MinIO **[CFG]** | S3-compatible | Object storage when `STORAGE_DRIVER=minio` |
| Meilisearch **[CFG]** | — | Full-text search when `SEARCH_ENGINE=meilisearch` |
| ClamAV **[CFG]** | — | Antivirus scanning when `CLAMAV_ENABLED=true` |
| Docker Compose (alternate path only) | — | Standalone/VPS deployment — Caddy, Postgres, Redis, MinIO, Meilisearch, ClamAV, Prometheus, Grafana, backup sidecar |

### 4.4 Upgrade considerations / known constraints

- Sequelize, exceljs, and minio are all **pinned below the version `npm audit fix --force` would install** — the `--force` targets are major-version *downgrades* for all three (no patched release exists on the current major per npm's advisory data). Never run `--force` in this repo; plain `npm audit fix` is safe (took the tree from 26 advisories to 12).
- 12 remaining advisories all need a genuine major bump (`next@16`, `nodemailer@10` — already at v10 — `sharp@0.35` — already current — `file-type@22`) plus the three pinned packages above; judge each individually, never batch.
- `xlsx` has no patched release on the public npm registry at all; the maintained build is distributed off-registry as `vendor/xlsx-0.20.3.tgz` (same tarball/checksum GMS uses).
- This is an **npm workspaces** repo (`backend`, `frontend`) — the lockfile is `package-lock.json` at the root; run `npm install` from the repo root, never from `frontend/` alone (or `xlsx`'s relative `file:` path breaks).

---

## 5. Database

### 5.1 Engine and connection

PostgreSQL 15+ (16 in the Docker Compose path). Connection built from `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`, or an explicit `DATABASE_URL` — but an ambient `DATABASE_URL` is **ignored** unless `DATABASE_URL_TRUSTED=true` is also set, specifically to defeat a stray machine-wide Railway/Render `DATABASE_URL` from an unrelated project silently winning (a known footgun; `config/env.ts` lines 303-317, 604-620). Pool: `DB_POOL_MAX=60` / `DB_POOL_MIN=2` / `DB_POOL_ACQUIRE_MS=30000` / `DB_POOL_IDLE_MS=10000`. Per-statement/transaction timeouts applied via `SET LOCAL` inside the request transaction, not connection-wide: `DB_STATEMENT_TIMEOUT_MS=30000`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS=120000` — deliberately transaction-scoped so they never abort the Umzug migration runner or a long backfill script sharing the same Sequelize instance.

**Production database role is never the superuser.** `edams_app` (least-privilege, `NOSUPERUSER NOBYPASSRLS`) is what the API/worker connect as — migrations run separately as the superuser (DDL/RLS-policy ownership; `edams_app` cannot execute DDL by design). `assertProductionRuntimeRequirements()` hard-refuses to boot if `DB_USER=postgres` or the password is empty, in production/staging. [V — `config/env.ts` lines 621-645]

### 5.2 Migration system

Umzug-driven, globbing `backend/migrations/*.sql` (97 forward files, each paired with a `.down.sql`), tracked in a `SequelizeMeta` table. `npm run db:migrate` / `db:migrate:prod` (superuser) / `db:migrate:status` / `db:migrate:check` (`check-migration-safety.ts` — a lint pass over pending migrations before they run). Migrations are numbered `YYYYMMDDNNNNNN-description.sql`. Down-migrations exist as files but `Documentations/rollout.md` states the down path is largely untested/unreliable in practice for a live system — the operative safety model is **expand/contract** (add nullable → backfill → make required in a later, separate deploy), not "migrate down if it goes wrong." See §30.5 and `Documentations/rollout.md` §3 for the full discipline.

Representative recent migrations (most recent 20 of 97, showing the kind of change this system evolves through): RLS coverage gaps + force-RLS, OIDC state binding + PKCE verifier, users external-sub uniqueness, form-templates letterhead flag, idempotency-key body-hash, drop of dead `related_document_ids`, ACL-entries tenant-resource index, access-rules tuple uniqueness, `document_status_action_roles` (the status-permission matrix table), letter pending-signature status, archived-checkout default restriction, signature-recipients role-assignment, letters assigned-signatory, drop of redundant duplicate indexes, user-session cutoffs (force-logout mechanism), audit-chain shards, form reference numbers. [V — `backend/migrations/` directory listing]

### 5.3 Row-Level Security (RLS)

RLS policies exist on every tenant-scoped table (migrations `20260815000001-legal-holds-rls`, `20260822000003-rls-coverage-gaps`, `20260822000004-rls-force`, plus the 2026-07-17 session's cutover-rehearsal fixes to six policies whose `current_setting('app.current_tenant', true) IS NULL` fail-open arm didn't correctly treat an empty string as unset). Enforcement depends on the connecting role being `edams_app`, not the superuser — RLS is **structurally bypassed** by a superuser connection, which is exactly why the boot guard refuses one in production. `tenantContext` middleware (`shared/middleware.ts`) issues `SET LOCAL app.current_tenant` inside the request's transaction so every query on a pooled connection carries the right tenant scope for the GUC-based policies to check.

### 5.4 Key entities (business + technical terms)

| Table | Business meaning | Technical notes |
|---|---|---|
| `tenants` | The organization(s) using this DMS instance — in production, just `examplecorp` | Slug string id (e.g. `examplecorp`), not a UUID |
| `users` | A person who can log in | **No `tenant_id` or `role` column** — those live in the JWT and `user_tenants`; a user is global, tenant access is a separate join |
| `user_tenants` | "This person belongs to this organization, with this role" | Many-to-many junction; adding/removing tenant access is a distinct admin action from creating the user (`Tenants → Members` UI) |
| `org_units` | A sister company, HQ, branch, or outlet within the Example Corp | Always a flat sibling directly under the tenant — `parent_unit_id` column exists but the API never sets it (§32.4) |
| `departments` | An organizational department (Finance, HR, Legal…), may have sub-departments | Self-referencing `parent_id` + `path` (ltree) + `level`, scoped to `org_unit_id` |
| `folder_nodes` | A category folder / sub-folder that documents are filed into | Self-referencing `parent_id` + `path`, bound to `department_id`; this is the *materialized* folder tree used for placement + ACL ancestry, distinct from the org-units/departments authoritative entity tree (§32.4) |
| `documents` | A managed document record — the central entity | 17-state `status` (§10); `tenant_id`+`document_name` composite-unique (not `document_name` alone — different tenants may share a name) |
| `document_versions` | An immutable version of a document's file content | One row per version; `fileSize` serialized as a string in API responses (BIGINT exceeds JS's 2^53 safe-integer range) |
| `document_deks` | The wrapped Data Encryption Key for one **version** (not one document) | `kekId` embeds the KEK version it was wrapped under (§17.4-equivalent, see §26.5) |
| `document_metadata` | Extended/custom metadata fields per document | — |
| `document_sequences` | Per-department/type/day counter for generating human-readable document names | Self-heals against names created outside it (seed fixtures, imports) |
| `document_status_action_roles` | The optional per-tenant status×action×role restriction matrix | Narrows, never widens, RBAC/ACL (§8.4) |
| `doc_locks` | A document explicitly locked against concurrent edits | Auto-released by `LockWorker` on expiry |
| `document_checkouts` | Checkout state for the checkout/checkin workflow | — |
| `document_comments` | Threaded comments on a document | — |
| `document_bundles` / `document_bundle_items` | An ordered grouping of documents that compiles into one combined document | Compilation goes through the *normal* document pipeline — inherits encryption/audit/ACL/retention automatically |
| `folder_nodes`, `acl_entries`, `access_rules` | ACL/permission substrate | See §26.2 |
| `approval_chain_templates` / `approval_chains` / `approval_steps` | The unified approval engine's admin-defined recipe, and each item's actual running chain/steps | See §12 |
| `audit_stage_reviews` | An item pending/decided at the post-approval audit stage | See §12.4 |
| `workflow_definitions` / `workflow_instances` / `workflow_tasks` | The **legacy**, still-live, per-document workflow engine (distinct from the unified approval engine) | `definition` JSON: `{stages: WorkflowStage[]}` |
| `retention_policies` | A named retention class → period/trigger/disposal-action mapping | — |
| `retention_applications` | Retention policy applied to a specific document | — |
| `legal_holds` / `document_legal_holds` | An active legal hold and its affected documents | The sole freeze mechanism (SYSTEM-DECISIONS.md D11) |
| `archive_records` | Cold/warm/WORM archive tier record | — |
| `purge_pending` | A staged (not-yet-approved) permanent destruction | Maker–checker: `staged_by_id` ≠ approver |
| `certificate_of_destruction` | Issued proof of a completed certified disposal | Retrieved once via `GET /documents/certificates/:reference` |
| `audit_logs` | The immutable, hash-chained, HMAC-signed audit trail | Sharded per-tenant (`AUDIT_CHAIN_SHARDS`, default 8) for write concurrency — see §26.6 |
| `outbox_events` | The transactional outbox queue | Channels: WEBSOCKET/EMAIL/WEBHOOK/OCR/SEARCH_INDEX |
| `webhook_subscriptions` | An external system's registered webhook callback | HMAC-SHA256 secret per subscription |
| `notifications` | An in-app notification for one user | — |
| `saved_searches` | A user's saved search query | — |
| `form_templates` / `form_instances` / `form_sequences` | Forms engine: a template definition and a filled instance | Template lifecycle state-guarded (`draft→pending_approval→active→deprecated`); instance carries a **frozen** `template_version` |
| `signature_requests` / `signature_recipients` / `signature_fields` / `signature_records` | E-signing envelopes, their recipients (internal + external), field placements, and finalized signature records | Recipients: internal (`dms_user_id`) or external (`access_token`, 7-day TTL) |
| `letters` | A CAMS correspondence record (outgoing or incoming) | 1:1 `document_id` link to the filed final PDF/scan |
| `letter_sequences` | Gap-free per-unit/type/year reference-number counter | PK `(tenant_id, org_unit_id, letter_type, year)`, locked `SELECT … FOR UPDATE` at allocation |
| `letter_revisions` | Pre-approval draft edit history for a letter | Auto-saved |
| `letter_approval_steps` | A letter's maker–checker–approver chain (letters keep their own chain implementation, not the unified engine) | Sequential, one PENDING at a time |
| `letter_attachments` | Supplementary files on a letter | Purges the backing CORR document graph on removal (no storage leak) |
| `letter_links` | Cross-reference index (REPLY_TO / RELATED / FOLLOW_UP) | Bidirectional query |
| `letter_dispatches` | Dispatch/delivery tracking for an outgoing letter | — |
| `idp_role_mappings` | AD-group-DN → DMS role-name mapping, per relying party (`edams`) | Managed by SSO's admin console via DMS's `/internal/roles` API |
| `oidc_grants` / `idp_clients` | OIDC state/config bookkeeping | — |
| `user_permission_overrides` | Per-user grant/revoke overrides on top of role-derived permissions | — |
| `user_session_cutoffs` | Force-logout mechanism — sessions issued before a cutoff timestamp are invalid | Migration `20260903000002` |
| `roles` / `role_permissions` | Role catalogue + DB-backed permission overrides on top of the static `ROLE_PERMISSIONS` fallback | — |
| `saved_search`, `feature_flags` (tenant JSON column) | Misc per-tenant config | — |

**FK convention** (stated explicitly in `ARCHITECTURE.md` because getting it wrong broke migrations once): every `*_by`/user-reference column is `UUID REFERENCES users(id)`; `tenant_id` is `VARCHAR REFERENCES tenants(id)` (tenant ids are slugs, not UUIDs). Mixing `TEXT` with the `UUID` PK breaks the foreign key at migration time — this was the Session-5 forms/e-signing fix.

### 5.5 Migrations, seed data, and lifecycle

Three seed levels, and the distinction is safety-critical (§24.1): `db:seed:reference` (production-safe: tenant, 7 roles, org units, departments, document types, retention policies, folder tree, default workflow), `db:seed:core` (adds 17 demo `@edams.local` users + a fake `demo-org` tenant — **not** for real deployments, though not blocked outright), `db:seed:reset` (truncate + re-seed-core, dev only).

### 5.6 Backup/restore

Covered fully in §25 (Backup and Disaster Recovery) — `pg_dump --format=custom` nightly (Docker path) or `scripts/db-backup.ts` (native path), `pg_restore --clean --if-exists --no-owner` to restore. The single hardest invariant: **`VAULT_MASTER_KEY` must be escrowed separately from both the DB dump and the blob backups** — without it, a perfectly restored database and file store are cryptographically inert (every DEK is unwrappable).

---

## 6. Complete API Reference

All paths below are relative to `API_BASE_PATH` (`/api/v1`). "Auth" column: **Public** = mounted outside `authenticate` entirely; **JWT** = requires a valid access token; **Internal** = shared-secret (`DMS_INTERNAL_API_KEY`) + IP allowlist, no user JWT. Permission is the `requirePermission()`/`requireAnyPermission()` gate; ACL column marks routes additionally gated by `requireACL()` (per-resource DENY-first check, §26.2). Source: every row below was read directly from the corresponding `*.routes.ts` file in this session (§ line references in the prose above each table).

### 6.1 Auth (`/auth`) — `modules/auth/auth.routes.ts` — mostly Public

| Method & Path | Auth | Purpose |
|---|---|---|
| POST `/auth/login` | Public (dev-only path, not 404'd in prod by 2026-07-31 decision) | Passwordless email login (`LOCAL_JWT_MOCK`) → `preTenantToken` |
| POST `/auth/dev/token` | Public (dev-only) | Explicit `{userId,role,tenantId}` token — tests only |
| GET `/auth/me` | JWT | Current principal + resolved permissions (authoritative for frontend UI gating) |
| POST `/auth/verify` | Public | Health stub, 204 |
| POST `/auth/select-tenant` | Pre-tenant token | Exchanges `preTenantToken`+`tenantId` for full access token |
| POST `/auth/switch-tenant` | JWT | Exchanges current token for a different tenant's token |
| POST `/auth/refresh` | Cookie (`refreshToken`) | New access token + rotated-scope refresh cookie |
| POST `/auth/logout` | JWT | Revokes access+refresh token (Redis blacklist), clears cookie |
| POST `/auth/totp/setup` | JWT | New TOTP secret + otpauth URI |
| POST `/auth/totp/confirm` | JWT | Verify code, permanently enable MFA |
| POST `/auth/totp/validate` | Public (mfaPendingToken) | Exchange MFA-pending token + code for full access token |
| POST `/auth/totp/disable` | JWT | Disable MFA (requires valid code) |
| GET `/auth/oidc/authorize` | Public | Redirects to IdP, sets binding cookie |
| POST `/auth/callback` | Public | Exchanges OIDC code, verifies id_token, issues DMS token |
| POST `/auth/oidc/jwks/refresh` | JWT, SYSTEM_ADMIN only | Force-refresh cached JWKS |
| POST `/auth/backchannel-logout` | Public (signed logout_token) | OIDC backchannel logout receiver — always 200 |

### 6.2 Documents (`/documents`) — `modules/documents/documents.routes.ts` — 40+ endpoints, all JWT, most ACL-gated on `document:*`

| Method & Path | Permission | ACL | Purpose |
|---|---|---|---|
| POST `/` | `document:upload` | — | Create document (multipart, ≤25MB buffered; >25MB via tus) |
| POST `/bulk` | `document:read` | — | Bulk operation across document IDs, 207 multi-status on partial failure |
| GET `/stats` | `document:read` | — | Dashboard stats |
| GET `/` | `document:read` | — | List (cursor/skip+take, many filters: folder/status/q/department/type/owner/ocrStatus/checkedOut/retentionRelevant/date range/sort) |
| GET `/trash` | `document:read` | — | Recycle bin listing, purge countdown |
| GET `/:id` | `document:read` | read | Document detail |
| GET `/:id/allowed-transitions` | `document:read` | read | Valid manual status transitions for this caller |
| PATCH `/:id/status` | `document:upload` | upload | Manual status transition (validated against `DocumentStateMachine`) |
| PATCH `/:id/metadata/apply-suggestion` | `document:upload` | upload | Apply one AI-suggested metadata field |
| GET `/:id/versions` | `document:read` | read | Version history |
| POST `/:id/checkout` / `/checkin` | `document:checkout` | checkout | Checkout/checkin |
| POST `/:id/versions` | `document:upload` | upload | Upload new version |
| POST `/:id/rollback` | `document:upload` | upload | Roll back to a prior version |
| POST `/:id/archive` | `document:archive` | archive | Archive |
| POST `/:id/publish` | `document:upload` | upload | Owner-driven publish for types opted out of approval |
| POST `/:id/lock`, DELETE `/:id/lock` | `document:checkout` | checkout | Lock/unlock |
| POST `/:id/force-unlock` | `document:checkout` | checkout | Force-unlock (role + mandatory reason enforced in service) |
| GET `/:id/lock-status` | `document:read` | read | Lock status |
| POST `/:id/trash` / `/:id/restore` | `document:archive` | archive | Soft delete / restore |
| DELETE `/:id` | `document:upload` | upload | Hard delete — **DRAFT documents only**, bypasses trash/purge entirely |
| GET `/certificates/:reference` | `document:purge` | — | Look up an issued Certificate of Destruction |
| POST `/:id/purge/stage` / `/approve` / `/cancel` | `document:purge` | purge | Maker–checker staged destruction |
| GET `/:id/download` | `document:read` | read | Stream/download file |
| GET `/:id/preview` | `document:read` | read | Thumbnail preview |
| GET `/:id/versions/diff` | `document:read` | read | Word-level version diff (capped at 5000 words/version) |
| POST `/:id/sign/request` / `/execute` / `/decline` | `signing:manage` | read | Legacy document-centric signing sub-routes |
| GET `/:id/sign/verify` | `document:read` | read | Verify signature |
| GET `/:id/history` | `audit:read` | read | Per-document audit history (≤500 events) |
| POST `/upload/tus`, `/upload/tus/*` | `document:upload` (mounted in `app.ts`, not this file) | — | Resumable upload (tus protocol) |

### 6.3 Unified Approvals (`/approvals`) — `modules/approvals/approvals.routes.ts` — full inline endpoint table exists in the file's own header comment

| Method & Path | Permission | Purpose |
|---|---|---|
| GET/POST `/templates` | `workflow:read` / `workflow:manage` | Chain templates (admin) |
| GET `/my/work` | `notification:read` | Unified "My Work" inbox |
| GET `/my/steps` | `approval:decide` | My pending approval steps |
| GET `/my/audits` | `audit-stage:decide` | My pending audit reviews |
| GET `/audit-reviews` | `workflow:read` | Audit-stage register |
| POST `/audit-reviews/:reviewId/decision` | `audit-stage:decide` | PASS/FLAG (idempotent) |
| POST `/audit-reviews/:reviewId/reassign` | `approval:decide` | Reassign stuck audit review |
| POST `/audit-reviews/items/:itemId/resubmit` | `approval:decide` | Re-enter audit after remediation |
| GET `/assignable-users` | submit/decide/audit-decide | Named-person/auditor picker |
| GET `/role-holders` | submit/decide | Current holders of named role(s) |
| GET `/prefill/:itemType/:itemId` | `approval:submit` | Pre-filled chain the author sees at submit |
| POST `/:itemType/:itemId/submit` | `approval:submit` | Self-service submit (idempotent) |
| GET `/:itemType/:itemId/chain` | `document:read` | Full chain view (visibility = item visibility, D9) |
| GET `/:itemType/:itemId/chains` | `document:read` | Every chain the item has ever had (history) |
| POST `/chains/:chainId/steps/:stepId/decision` | `approval:decide` | APPROVE / REQUEST_CHANGES / DECLINE |
| POST `/chains/:chainId/steps/:stepId/reassign` | `approval:admin` | Stuck-step recovery |
| POST `/chains/:chainId/cancel` | `approval:admin` | Admin cancel with reason |

`itemType` ∈ `DOCUMENT` \| `FORM_TEMPLATE` \| `FORM_INSTANCE` (letters keep their own chain — see §6.9).

### 6.4 Letters / CAMS (`/letters`) — `modules/letters/letters.routes.ts` — ~28 endpoints

| Method & Path | Auth | Permission | Purpose |
|---|---|---|---|
| GET `/letters/verify` | **Public** (own IP rate limit, 30/min) | — | QR authenticity verification — `?ref=&hash=` |
| GET `/` | JWT | `letter:read` | List (direction/status/orgUnit/dept/year/type/q/overdue filters) |
| POST `/` | JWT | `letter:create` | Draft new outgoing letter |
| POST `/register` | JWT | `letter:register` | Register incoming letter (multipart scan) |
| POST `/scanned` | JWT | `letter:create` | Outgoing letter filed as a scan of a signed paper original |
| GET `/by-document/:documentId` | JWT | `letter:read` | Reverse lookup: is this Document a filed letter? |
| GET `/assignable-users` | JWT | create/review/approve | Candidate named-person assignees |
| GET `/:id` | JWT | `letter:read` | Letter detail |
| GET `/:id/revisions/:revisionNo` | JWT | `letter:read` | Full body of one draft revision |
| PATCH `/:id` | JWT | `letter:create` | Update draft |
| POST `/:id/attachments` | JWT | `letter:create` | Add attachment |
| GET `/:id/attachments/:attachmentId` | JWT | `letter:read` | Download attachment |
| DELETE `/:id/attachments/:attachmentId` | JWT | `letter:create` | Remove attachment (purges backing document graph) |
| POST `/:id/submit` | JWT | `letter:create` | Submit for approval chain |
| POST `/:id/initiate-signing` | JWT (idempotent) | `letter:create` | Pick the SIGNATORY (separate from approval) |
| POST `/:id/steps/:stepId/decision` | JWT (idempotent) | enforced in service | REVIEW/APPROVE decision |
| POST `/:id/steps/:stepId/reassign` | JWT | enforced in service | Admin recovery — stuck step |
| GET `/:id/pdf` | JWT | `letter:read` | Download final letter (or scan) |
| GET `/:id/cover-sheet` | JWT | `letter:read` | Download cover sheet |
| POST `/:id/dispatches` | JWT | `letter:dispatch` | Record dispatch |
| POST `/:id/dispatches/:dispatchId/acknowledge` | JWT | `letter:dispatch` | Acknowledge delivery |
| POST `/:id/cancel` | JWT | `letter:create` | Cancel (DRAFT/RETURNED owner; IN_REVIEW admin override) |
| POST `/:id/assign` | JWT | `letter:register` | Route incoming letter to a department |
| POST `/:id/resolve` | JWT | `letter:register` | Mark incoming letter RESPONDED/CLOSED |
| GET `/:id/links` | JWT | `letter:read` | Cross-reference thread |
| POST `/:id/links` / DELETE `/:id/links/:linkId` | JWT | `letter:create` | Create/remove cross-reference (mutation — fixed from a read-only-permission gap, "L9") |
| POST `/:id/archive` | JWT | `letter:dispatch` | Archive |

### 6.5 E-Signing (`/documents/:documentId/signing`, `/signing/*`) — `modules/esigning/esigning.routes.ts`

| Method & Path | Auth | Permission | Purpose |
|---|---|---|---|
| GET/POST `/documents/:documentId/signing` | JWT | `signing:read`/`signing:manage` + ACL `document:read` | List/create signature requests for a document |
| GET `/signing/requests?scope=` | JWT | `signing:read` | Cross-document queue: pending-me / sent-by-me / completed |
| GET `/signing/assignable-users` | JWT | `signing:manage` | Signer picker |
| POST `/signing/uploads` | JWT | `signing:manage` | Upload-and-file a new document directly into a signing flow |
| GET `/signing/:requestId` | JWT | `signing:read` | Request detail (recipients + fields) |
| POST `/signing/:requestId/send` | JWT | `signing:manage` | draft→sent, emails recipients |
| POST `/signing/:requestId/remind` | JWT | `signing:manage` | Re-send to not-yet-signed recipients |
| POST `/signing/:requestId/recipients/:recipientId/sign` | JWT (idempotent) | `signing:read` (caller-is-recipient enforced in service) | Internal signer submits signature |
| POST `/signing/:requestId/recipients/:recipientId/decline` | JWT | caller-is-recipient (service) | Internal decline |
| POST `/signing/:requestId/recipients/:recipientId/sign/external` | **Public** (`access_token` in body) | — | External signer submits signature |
| GET `/signing/:requestId/recipients/:recipientId/view` | **Public** (`?token=`) | — | Marks recipient 'viewed' |
| POST `/signing/:requestId/recipients/:recipientId/decline/external` | **Public** (`access_token` in body) | — | External decline |

Legacy route `POST /signing/:documentId/sign` (`modules/signing/signing.routes.ts`) also exists for backwards compatibility, same permission/ACL shape as the document-centric route.

### 6.6 Forms (`/forms`) — `modules/forms/forms.routes.ts`

| Method & Path | Permission | Purpose |
|---|---|---|
| GET `/templates` | `document:read` | List templates |
| POST `/templates/base-pdf` | `doctype:manage` | Upload base PDF for a template |
| GET `/templates/letterhead` | `doctype:manage` | Fetch letterhead asset |
| POST `/templates/preview` | `doctype:manage` | Render preview |
| POST `/templates` | `doctype:manage` | Create template (draft) |
| GET `/templates/:id` | `document:read` | Template detail |
| PATCH `/templates/:id/status` | `doctype:manage` | State-guarded lifecycle transition |
| PATCH `/templates/:id/content` | `doctype:manage` | Edit template content |
| POST `/templates/:id/versions` | `doctype:manage` | New template version |
| GET `/templates/:id/approval-prefill` | `document:upload` | Pre-filled approval chain for an instance of this template |
| GET `/instances` | `document:read` | List instances |
| POST `/instances` | `document:upload` | Create instance (multipart — data + optional approval chain + file fields), renders via pdfme, files as Document |
| GET `/instances/:id` | `document:read` | Instance detail |

### 6.7 Workflow (legacy, `/workflow`) — `modules/workflow/workflow.routes.ts`

| Method & Path | Permission | Purpose |
|---|---|---|
| GET/POST/PATCH/DELETE `/definitions` | `workflow:read`/`workflow:manage` | Stage/SLA/approver-role definition CRUD (now reachable from Operations → Workflow Definitions) |
| GET `/instances`, `/instances/:instanceId`, `/instances/:instanceId/tasks` | `workflow:read` | Running instance/task visibility |
| POST `/instances/:instanceId/tasks/:taskId/decide` | `workflow:approve` + ACL `workflow_task` | Decide a stage task |
| GET `/tasks` | `workflow:read` | Flat pending-task list for current user/role |
| POST `/tasks/:taskId/decide` | `workflow:approve` + ACL | Legacy decide endpoint |
| POST `/documents/:id/workflow/start` | `workflow:manage` + ACL `document:upload` | Start a workflow instance on a document |

### 6.8 Other document-adjacent modules

| Module | Base path | Key endpoints |
|---|---|---|
| Comments | absolute paths | `GET/POST /documents/:documentId/comments`, `DELETE /comments/:commentId` — all `document:read` + ACL |
| Bundles | `/bundles` | `GET/POST /`, `GET /:id`, `POST /:id/items`, `PATCH /:id/items/reorder`, `DELETE /:id/items/:itemId`, `POST /:id/compile` — all `document:read` |
| Legal Hold | `/legal-hold` | `POST/GET /`, `GET /export` (CSV/JSON), `GET/POST /:id`, `/:id/add-documents`, `/:id/release`, `/:id/history` — `legalhold:read`/`legalhold:manage` (RBAC only — no per-resource ACL, see §26.2 finding) |
| Retention | `/retention` | `GET/POST /`, `GET/PATCH/DELETE /:id`, `POST /cold-restore/:documentId`, `POST /disposal/:documentId/authorise` — `retention:read`/`retention:manage` |
| Folders | `/folders` | `GET /tree`, `GET /`, `POST /`, `GET /department/:departmentId`, `GET/PATCH/DELETE /:id`, `GET /:id/contents` |
| Departments | `/departments` | `GET /`, `GET /tree`, `POST /`, `GET/PATCH/DELETE /:id`, `PATCH /:id/move` |
| Document Types | `/document-types` | `GET /`, `GET /for-department`, `POST /`, `GET/PATCH/DELETE /:id` |
| Org Units | `/org-units` | `GET /`, `POST /`, `PATCH /:id` — flat-only creation enforced (§32.4) |
| Status Permissions | `/status-permissions` | `GET` (two variants), `PUT` — admin editor for the optional status×action×role narrowing matrix |
| Search | `/search` | `GET /` (query+filters+facets), `POST/GET /saved`, `DELETE /saved/:id` |
| Reports | `/reports` | `GET /` (permitted-only listing), `GET /storage/analytics`, `GET /dashboard`, `GET /letters/volume`, `GET /:key` (JSON or `?format=csv`) |
| Webhooks | `/webhooks` | `GET/POST /`, `DELETE /:id` — all `operations:manage` |
| Notifications | `/notifications` | `GET /unread-count`, `GET /`, `PATCH /:id/read`, `PATCH /read-all` |
| Roles | `/roles` | `GET /`, `POST /`, `GET/PUT /:id/permissions` |
| Tenants | `/tenants` | `GET/POST /`, `GET/PATCH/DELETE /:id`, `PUT /:id/exec-notice-config`, `GET/POST /:id/members`, `DELETE /:id/members/:userId` |
| Users | `/users` | `GET /`, `GET/PUT /me*` (profile, signature image, exec-notice opt-out, notification prefs), `POST /`, `GET/PATCH/DELETE /:id`, `/:id/activity`, `/:id/activate`/`deactivate`/`force-logout`, `/:id/roles`, `/:id/permission-overrides`, `/:id/departments` |
| Access Rules | `/access-rules` | `GET/POST /`, `GET/DELETE /:id` — all `acl:manage` |
| ACL | `/acl` | `POST/GET /:resourceType/:resourceId`, `GET/DELETE /:aclId`, `GET /`, `POST /:resourceType/:resourceId/bulk` — all `acl:manage` |
| Audit | `/audit` | `GET` (4 endpoints — event listing/filters) — `audit:read` |
| AI | `/ai` | `POST /chat` (`audit:read` + tenant consent gate), `GET/POST /documents/:id/summary`\|`suggestions`\|`summarize`\|`extract` (`document:read` + ACL) |
| Assignment Advisory | `/assignment-advisory` | 2× `GET` — candidate-assignee suggestions |
| Feature Flags | absolute paths | `GET/PATCH /tenants/:tenantId/feature-flags` |

### 6.9 Operations (`/operations`) — mixed public/protected — `modules/operations/operations.routes.ts`

| Method & Path | Auth | Permission | Purpose |
|---|---|---|---|
| GET `/health` | **Public** | — | Cached (5s TTL), single-flight-probed liveness: db/redis/minio/meilisearch/outbox |
| GET `/outbox` | JWT | `operations:read`/`operations:manage` | Non-terminal outbox events (≤50) |
| POST `/outbox/:id/retry` | JWT | `operations:manage` | Reset an event to PENDING |
| GET `/crypto-status` | JWT | `operations:read`/`operations:manage` | KEK-rotation visibility (mirrors `rewrap-deks.ts --dry-run`) |
| GET `/pipeline-metrics` | JWT | `operations:read`/`operations:manage` | OCR/AI/outbox job outcome counts + durations |

Plus `GET /api/v1/metrics` (top-level, `operations:manage`, Prometheus text format) and an optional unauthenticated `/metrics` (root path, `ENABLE_PUBLIC_METRICS_ROUTE`, internal-network-only).

### 6.10 Internal admin API (`/internal/roles`) — `modules/roles/internal.routes.ts` — Internal auth only

Mounted **outside** the normal `authenticate` chain entirely — gated by `requireInternalApiKey` (shared secret) + `internalApiRateLimit` + an IP allowlist (`INTERNAL_API_ALLOWED_IPS`, default loopback-only). This is the SSO admin console's back-channel into DMS.

| Method & Path | Purpose |
|---|---|
| GET `/tenants/:tenantId/roles` | List DMS roles |
| GET `/tenants/:tenantId/role-mappings` | List every configured AD-group DN |
| POST `/tenants/:tenantId/role-mappings/resolve` | Resolve a set of AD group DNs → DMS role names (used at SSO token-issuance time) |
| GET/PUT `/tenants/:tenantId/role-mappings/:groupDn` | Read/set one group→role mapping (audited) |
| GET `/tenants/:tenantId/users/by-email/:email/status` | User existence/active/roles lookup |
| GET/PUT `/tenants/:tenantId/roles/:roleId/permissions` | Read/replace a role's DB-backed permission set |
| GET/PUT `/tenants/:tenantId/users/:userId/permission-overrides` | Read/replace a user's grant/revoke overrides |

The caller's *asserted* identity (an admin operating the SSO console) travels as an `x-internal-actor` header and is recorded in `actionDetails`, never in `audit_logs.user_id` (a real Postgres UUID column with no room for an email string, and no FK to a DMS user since the actor is an SSO admin, not necessarily a DMS one).

---

## 7. Authentication, Authorization and SSO

### 7.1 Two-phase tenant selection (the core auth contract)

Every login — mock or real SSO — ends up at the same two-phase handshake: `POST /auth/login` (or the OIDC callback) returns a **tenant-less** `preTenantToken` (carries `userId`, no `tenantId`) plus the caller's tenant list, and sets the HttpOnly `refreshToken` cookie immediately *only if* the user has exactly one tenant. `POST /auth/select-tenant` (bearer = the pre-tenant token) exchanges it for the **full** access token — `tenantId`, `role`, `permissions[]`, a `jti` (UUID v4, for revocation). Every verifier and integration test in the repo speaks this exact contract; `test-scripts/verify-phase1-3` (despite the legacy name) are what pin it down. [V — `ARCHITECTURE.md` "Authentication Flow"]

`POST /auth/switch-tenant` re-runs the same exchange for an already-authenticated user moving to a different tenant they belong to, rotating the refresh cookie to the new scope.

### 7.2 Token mechanics

- **Access token**: RS256, signed with `DEV_RSA_PRIVATE_KEY` in dev/mock mode; a real SSO-issued token is verified against the IdP's JWKS in production. `JWT_ACCESS_EXPIRES_IN` default `15m`.
- **Refresh token**: HS256 (`JWT_REFRESH_SECRET`), stored only in an HttpOnly cookie (never JS-readable), default `8h` (`JWT_REFRESH_EXPIRES_IN`). `POST /auth/refresh` recomputes permissions from the DB fresh (not from the stale token) and issues a new access token with a fresh `jti` — **no refresh-token rotation on this call** (the same refresh cookie is reused until logout or its own expiry).
- **Revocation**: `POST /auth/logout` writes `revoked:{jti}` into Redis with TTL = the token's remaining lifetime; `authenticate()` checks this blacklist on every request. **Revocation fails closed in production**: if Redis is unreachable, every authenticated request gets `503 ERR-AUTH-REVOCATION-UNAVAILABLE` rather than silently honoring a token whose revocation status cannot be verified. Development/test keep the fail-open path so isolated unit tests need no Redis. [V — `README.md` "Authentication"]
- **Force-logout**: `user_session_cutoffs` table — an admin action (`POST /users/:id/force-logout`) invalidates every session issued before a stamped cutoff time, independent of the Redis blacklist mechanism (covers tokens issued before Redis even had a chance to record a `jti`-specific revocation).
- **Storage**: access token in `localStorage["dms-auth"]` (Zustand persistence); refresh token only in the HttpOnly cookie.

### 7.3 SSO / OIDC (production auth path)

DMS is a **real OIDC relying party** of the platform IdP — client id `edams` (see §33.1 for why this isn't renamed to `dms`). Full flow:

1. `GET /auth/oidc/authorize` — backend generates random `state` + `nonce`, stores both in Redis (10-minute TTL), sets a browser-binding cookie, redirects to the IdP.
2. IdP authenticates, redirects to `OIDC_REDIRECT_URI?code=&state=`.
3. Frontend POSTs `{code, state}` to `POST /auth/callback`.
4. Backend verifies `state` against Redis (**fails closed with 503 if Redis is down** — the same reasoning as revocation: an unverifiable CSRF/replay guard must not be silently skipped), checks the presented binding cookie, exchanges the code for tokens at `OIDC_TOKEN_ENDPOINT` (or `AUTH_ISSUER + /token`), and verifies the id_token signature against JWKS fetched from `AUTH_JWKS_URI` (cached in-memory, kid→PEM, 1-hour TTL; an unknown `kid` forces one immediate cache refresh before failing).
5. Requires `email_verified === true` in the id_token.
6. JIT-provisions (or finds) the local user by the `email` claim, gives them a real `user_tenants` membership row for the default tenant (not just a login-time fallback), and resolves roles from the `ad_groups`/`edams_roles` claims via `idp_role_mappings` (per relying party `edams`) — an unmatched user falls back to `EMPLOYEE`. **`OIDC_SCOPES` must explicitly request `ad_groups edams_roles`** — as of a platform-wide SSO change these moved out of the `profile` scope; omitting them silently flattens every first-time SSO user to `EMPLOYEE`.
7. Issues a standard DMS RS256 access token + refresh cookie — identical to the dev-mock flow from this point on. Multi-tenant users still go through `select-tenant`.
8. `POST /auth/oidc/jwks/refresh` (SYSTEM_ADMIN only) forces an immediate JWKS re-fetch after a known key-rotation event at the IdP.
9. `POST /auth/backchannel-logout` receives a signed OIDC backchannel logout token when a user signs out at the SSO portal or is disabled there — always responds 200 regardless of whether the subject is known, to avoid leaking which subjects exist.

### 7.4 Login flow (dev mock, `LOCAL_JWT_MOCK=true`)

Passwordless — `POST /auth/login {email}` issues a token for any seeded `@edams.local` account, no password check. **This is also reachable in production** by an explicit 2026-07-31 decision (so the seeded demo accounts can be used for a live walkthrough on the production box) — the route is not 404'd, but `LOCAL_JWT_MOCK` itself must be explicitly set true for the mock path inside the handler to actually fire, and mock tokens only verify against `DEV_RSA_PUBLIC_KEY` via a dev-only `kid` — a real SSO-issued token's `kid` never matches, so this cannot be used to forge a real production session; it only lets someone sign in as a seeded demo user. `config/env.ts`'s boot guard logs a loud warning (not a refusal) if `LOCAL_JWT_MOCK=true` in production/staging.

### 7.5 Failure behavior summary

| Condition | Behavior |
|---|---|
| Redis unreachable, checking revocation | `503 ERR-AUTH-REVOCATION-UNAVAILABLE` (prod/staging); fail-open in dev/test |
| Redis unreachable, OIDC state check | `503` (fails closed — same reasoning) |
| Unknown JWKS `kid` | One forced cache refresh, then fail if still unknown |
| Expired/invalid access token | `401` from `authenticate()` middleware |
| Missing pre-tenant token at `/select-tenant` | `401 ERR-AUTH-REQUIRED` |
| id_token `email_verified !== true` | Callback rejected |
| Backchannel logout for unknown subject | `200 {ok:true}` (deliberately non-leaking) |

### 7.6 Cross-system behavior

DMS's `/internal/roles/*` API is the one place another system (SSO's admin console) reaches directly into DMS's authorization data — see §6.10. In the other direction, DMS never calls into SSO except at login/JWKS-fetch time; there is no live session-sharing mechanism beyond the OIDC token flow itself.

---

## 8. Roles and Permission Model

### 8.1 Two-layer model (stated explicitly in the codebase — not a fixed enterprise role taxonomy)

- **Layer 1 — global RBAC.** Every endpoint declares a permission string (`PERMISSIONS.X`). `requirePermission()`/`requireAnyPermission()` (`shared/auth.ts`) resolves it against DB-backed `role_permissions` (per-tenant overridable), with `config/permissions.ts`'s `ROLE_PERMISSIONS` as the static fallback. An unrecognized role gets **zero** permissions.
- **Layer 2 — resource ACL.** `resolveACL()` (`shared/resolveACL.ts`) evaluates `acl_entries` + `access_rules`, DENY-first, walking folder and department ancestry (§26.2). A DENY at any level wins regardless of what Layer 1 allowed.
- The seeded role names (`SYSTEM_ADMIN`, `RECORDS_OFFICER`, `DEPT_MANAGER`, `APPROVER`, `EMPLOYEE`, `AUDITOR`, `EXECUTIVE`) are a **reference configuration**, not architectural constants. Application logic, routing, and UI never string-match a role name in business logic — the frontend gates on `can(permission)` / `<PermissionGate permission="...">`, and the backend gates on the permission string. `user_permission_overrides` and per-tenant `role_permissions` rows can diverge a real deployment from this default table entirely.

### 8.2 The permission catalogue (52 permissions, `config/permissions.ts`)

Grouped by domain: `document:*` (read, read_all, upload, archive, purge, checkout), `version:manage`, `folder:*` (create, read, delete), `user:manage`, `role:read`/`role:manage`, `department:read`/`department:manage`, `doctype:read`/`doctype:manage`, `audit:read`, `workflow:read`/`manage`/`approve`, `retention:read`/`manage`, `legalhold:read`/`manage`, `search:read`/`search:scope_all`, `notification:read`, `signing:read`/`manage`, `operations:read`/`manage`, `acl:manage`/`acl:bypass_admin`, `tenant:read`/`manage`, `letter:read`/`read_all`/`create`/`review`/`approve`/`dispatch`/`register`, `orgunit:read`/`manage`, `approval:submit`/`decide`/`admin`, `audit-stage:decide`.

### 8.3 Role → permission matrix (as seeded, `ROLE_PERMISSIONS`)

| Role | Scope / purpose | Notable grants | Notable exclusions |
|---|---|---|---|
| **SYSTEM_ADMIN** | Full platform admin | Every permission in the catalogue (`Object.values(PERMISSIONS)`) | None |
| **RECORDS_OFFICER** | Records-management specialist | `document:read_all`, `document:purge` (deliberately granted so the two-person destruction rule is exercisable — a records officer stages, a second officer or admin approves; before this only the single seeded SYSTEM_ADMIN could purge, deadlocking the maker≠checker rule), `retention:*`, `legalhold:*`, `search:scope_all`, `letter:read_all`, full approval permissions | No `user:manage`, no `tenant:manage` |
| **DEPT_MANAGER** | Department head | `department:manage`, `user:manage`, `role:read`/`role:manage`, `workflow:approve`, `letter:review`/`approve`/`dispatch`/`register`, full approval permissions, `signing:read` (department managers are the most common named signatory) | No `document:read_all`, no `retention:manage` |
| **APPROVER** | A person named as an approval-chain participant | `workflow:approve`, `letter:review`/`approve`, `approval:submit`/`decide` | No `document:upload`, no admin/user-management permissions — a narrow, decision-focused role |
| **EMPLOYEE** | Ordinary staff member | `document:upload`, `document:checkout`, `letter:create`, `approval:submit`/`decide`, `signing:read` (any employee can be named a signing recipient) | No approval/audit management, no oversight scope |
| **AUDITOR** | Compliance/audit oversight | `document:read_all`, `audit:read`, `search:scope_all`, `operations:read`, `letter:read_all`, `audit-stage:decide` (the D5–D7 audit-stage decider role) | No write permissions on documents at all — read/decide only |
| **EXECUTIVE** | Standing oversight recipient for correspondence notifications | `letter:read`/`read_all`, `orgunit:read`, `department:read`, `signing:read` | Deliberately **read-only across the tenant**, not scoped to one department, and explicitly **not** a participant in the review/approval chain itself — this is the role the D10 "configurable executive notices" feature targets |

Display-priority order (`ROLE_RANK`, used only for choosing which role label to show when a user holds several — never for authorization logic): `SYSTEM_ADMIN > EXECUTIVE > RECORDS_OFFICER > DEPT_MANAGER > APPROVER > AUDITOR > EMPLOYEE`.

### 8.4 The optional status×action×role narrowing matrix

A *second*, orthogonal authorization layer, `document_status_action_roles` (`modules/documents/statusPermissions.service.ts`): lets a tenant admin say "only roles A and B may perform ACTION while a document is in STATUS", on top of — never instead of — the RBAC+ACL checks every action already enforces. It only **narrows**; absence of a configured rule for a `(tenant, status, action)` tuple means fully unrestricted (whatever RBAC/ACL already allow). Gated actions are a fixed, curated list (`STATUS_GATED_ACTIONS`): read, download, preview, checkout, checkin, upload_version, rollback, archive, publish, status_change, lock, unlock, force_unlock, trash, restore, delete_permanent, purge_stage, purge_approve, purge_cancel. Editable at `GET/PUT /status-permissions`.

### 8.5 How permissions are enforced — frontend vs backend

- **Backend**: every route declares `requirePermission(PERMISSIONS.X)` or `requireAnyPermission(...)`; resource-scoped routes additionally chain `requireACL({resourceType, permission})`. There is no code path that checks a role string directly for authorization (`userHasPermission()` in `config/permissions.ts` is the one sanctioned helper, and it takes a permission, not a role comparison).
- **Frontend**: `shared/hooks/usePermissions.ts` exposes `can(permission)`; `shared/components/PermissionGate` wraps UI that should only render for a given permission. `GET /auth/me`'s `permissions[]` array (resolved server-side, unioned across all of a user's roles via the single `resolveUnionPermissions()` helper in `roles.service.ts` — deliberately centralized after being copy-pasted at eight token-issuing sites before) is the authoritative source the frontend gates against; `role` in the response is informational display-only.

---

## 9. Complete Business Workflows

### 9.1 Generic document approval (the common case)

- **Trigger**: author submits a DRAFT document (`POST /approvals/DOCUMENT/:id/submit`) or, for types that opted out of approval (`DocumentType.requiresApproval=false`), calls `POST /documents/:id/publish` directly.
- **Actor**: the document owner (or anyone with `approval:submit` and edit rights on it).
- **Preconditions**: document in `DRAFT`; a chain template exists for the document's type (or an unscoped default).
- **Steps**: `GET /approvals/prefill/DOCUMENT/:id` shows the pre-filled chain (locked steps immutable, unlocked steps editable — swap role for named person, add/reorder optional steps); submit creates an `approval_chain` + ordered `approval_steps`, moves the document `DRAFT→IN_REVIEW`; each step activates sequentially — exactly one `PENDING` step at a time (DB CHECK constraint enforces named-user XOR role, never both/neither).
- **Validation**: `document:read` visibility gating on the chain view (D9 — chain visibility follows item visibility, no participants-only masking); decline requires a mandatory comment.
- **State changes**: `IN_REVIEW → APPROVED` (all steps APPROVE) or `→ CHANGES_REQUESTED` (bounced to author, chain suspended, resubmit possible) or `→ DECLINED` (hard rejection, but revisable — D3: author edits and resubmits, starting a **fresh** chain, same visible item/history).
- **Post-approval routing** (per document-type policy, decided at type-configuration time, not per-submission): `auditPolicy` (`required`/`optional`/`never`) → `PENDING_AUDIT`; `signingPolicy` → `PENDING_SIGNATURE`; neither → `ACTIVE`/`ARCHIVED` directly.
- **Notifications**: `APPROVAL_STEP_PENDING`, `APPROVAL_CHANGES_REQUESTED`, `APPROVAL_DECLINED`, `APPROVAL_COMPLETED`, `APPROVAL_CANCELLED` (in-app + Socket.IO, via the outbox).
- **Audit trail**: every submit/decision/reassign/cancel writes an `AuditLog` row inside the same transaction as the state change (never fire-and-forget).
- **Exceptions**: admin `reassign` (stuck step — deactivated assignee, unstaffed role) and `cancel` (with mandatory reason) require `approval:admin`.
- **Final state**: `ACTIVE` (published) or `ARCHIVED`, or a terminal `DECLINED`/`CANCELLED` if never resubmitted.

### 9.2 Audit stage (SYSTEM-DECISIONS.md D5–D7)

- **Trigger**: approval completes and the document type's `auditPolicy` requires it (or the final approver opts in under `optional`).
- **Actor**: the **final approver personally selects a named auditor** (`GET /approvals/assignable-users?capability=audit`) — no auto-assignment, no shared claim-queue (D6, a deliberate divergence from the original proposal's round-robin suggestion).
- **Steps**: document → `PENDING_AUDIT`; an `audit_stage_reviews` row is created for the chosen auditor; the auditor decides `POST /approvals/audit-reviews/:reviewId/decision` — **PASS** (→ `AUDITED`, archivable) or **FLAG** (mandatory written findings, → `AUDIT_FLAGGED`, returned to the **final approver**, not the drafter — D7, another deliberate divergence).
- **Independence enforced**: an auditor can never audit an item they drafted or approved themselves (checked in `auditStage.service.ts`).
- **Remediation loop**: the final approver fixes the issue (themselves or by pulling in the drafter), then `POST /approvals/audit-reviews/items/:itemId/resubmit` (naming a — possibly different — auditor) re-enters `PENDING_AUDIT`.
- **Admin recovery**: `POST /approvals/audit-reviews/:reviewId/reassign` (stuck review → different auditor, `approval:decide`).
- **Audit trail**: audit decisions write their own dedicated audit-log event types, distinct from the plain approval-decision events.

### 9.3 E-signing ceremony (SYSTEM-DECISIONS.md D8)

- **Trigger**: a document type's `signingPolicy` requires it, and the document reaches `APPROVED` (auto-triggered) — or a user manually starts one via `POST /documents/:documentId/signing` on any document at `ACTIVE` or later.
- **Steps**: fields placed on the PDF (freeform, or resolved from a Phase-7 form template); named recipients invited — internal (matched by `dms_user_id`) or external (issued a 7-day `access_token`, emailed a signing link); ordering `parallel` (any order) or `serial` (a recipient may only sign once every lower `order_index` recipient has signed, enforced with `409 ERR-SIGNING-OUT-OF-ORDER`).
- **Completion**: when all recipients sign, the request → `completed`; document → `SIGNED`; if `completion_action='move_folder'`, the document moves and its ACL cache is invalidated. A signed, flattened PAdES copy is filed as a new document version, best-effort, post-commit (`esignPades.ts`, needs `ESIGN_P12_B64`).
- **Decline**: any recipient may decline (mandatory reason) — document → `SIGNING_DECLINED`, re-signable or cancellable.
- **Expiry**: `EsigningExpiryWorker` sweeps `sent`/`partially_signed` requests past `expiresAt` → `expired` (a lazy check also runs on the hot `signDocument()` path, but a request nobody revisits needs the producer).
- **Post-signing routing**: `SIGNED → PENDING_AUDIT` or `→ ACTIVE`/`ARCHIVED`, same per-type policy as §9.1.

### 9.4 CAMS — outgoing letter (maker–checker–approver)

- **Trigger**: `POST /letters` (compose) or `POST /letters/scanned` (file a scan of a signed paper original).
- **Actor**: a drafter with `letter:create`.
- **Steps**: `DRAFT` (auto-saving edits to `letter_revisions`) → `POST /letters/:id/submit` → `IN_REVIEW`, running the letter's own maker–checker–approver chain (`letter_approval_steps` — sequential, one PENDING at a time, last step must be APPROVE). A step decision is `POST /letters/:id/steps/:stepId/decision` — per-step permission (REVIEW vs APPROVE) enforced in the service.
- **Returned path**: any reviewer can bounce it → `RETURNED`, drafter edits and resubmits.
- **Final approval**: allocates the reference number (`REF/UNIT/DEPT/TYPE/YEAR/SEQ`) from `letter_sequences` under `SELECT … FOR UPDATE` (gap-free, gated on this transaction, not earlier) → `APPROVED`; if the type requires a signing ceremony, `POST /letters/:id/initiate-signing` picks the SIGNATORY (a *separate* action from picking approvers) → `PENDING_SIGNATURE` → completion advances to `APPROVED`'s onward path.
- **PDF rendering**: letterhead, server-stamped date, signatory block from the approving user's profile (handwritten signature image if uploaded, D8c), and a QR code encoding `CAMS_VERIFY_BASE_URL?ref=&hash=` — pdf-lib, Amharic via embedded Noto Sans Ethiopic font (subset), pure-Latin via Helvetica.
- **Dispatch**: `POST /letters/:id/dispatches` records dispatch/delivery tracking; `POST /letters/:id/dispatches/:dispatchId/acknowledge` closes the loop.
- **Archive**: `POST /letters/:id/archive` (`letter:dispatch`) → `ARCHIVED`.
- **Cancel**: `DRAFT`/`RETURNED` (owner-only, no reason needed) or, as an admin recovery override, `IN_REVIEW` (department:manage/admin bypass + mandatory reason).
- **Audit trail**: every step decision, reference allocation, and dispatch writes an audit event; `letter_links` records any cross-reference threading created along the way.

### 9.5 CAMS — incoming letter registration

- **Trigger**: `POST /letters/register` (multipart `scan`) — a records clerk or scan operator files the physical/emailed original.
- **Steps**: scan filed encrypted as a `CORR`-type Document; `OCR` + `SEARCH_INDEX` outbox events queued; routed to a department with an optional due date and assignee (`POST /letters/:id/assign`); can thread to an existing outgoing letter via a `REPLY_TO` link (`POST /letters/:id/links`); gets its own `.../IN/...` registration number from the same `letter_sequences` mechanism, at intake (not deferred to any later approval step — incoming mail is already a fact, not a draft).
- **Resolution**: `POST /letters/:id/resolve` marks it `RESPONDED` or `CLOSED` once actioned (due-date tracking).

### 9.6 Retention and certified disposal

- **Trigger**: `RetentionPurgeWorker`'s daily 02:00 cold-storage-tiering sweep (archived documents past their policy's trigger date, skipping anything on legal hold) and its 03:00 two-stage-purge sweep (trashed documents past their 7-day cooling period, staged for permanent destruction).
- **Manual staging**: `POST /documents/:id/purge/stage` (records officer) sets a `purge_pending` row with `staged_by_id`.
- **Maker–checker**: `POST /documents/:id/purge/approve` **must be a different user** than the stager (D12) — the service explicitly rejects same-user approval, which is why `RECORDS_OFFICER` was deliberately given `document:purge` (previously only the single seeded `SYSTEM_ADMIN` held it, deadlocking the rule).
- **Execution**: `executePurge()` (`trashService.ts`) irreversibly deletes the document row, its versions, and — post-commit, via `transaction.afterCommit()` — the encrypted blob(s) from storage, and issues a **Certificate of Destruction** (retrievable once via `GET /documents/certificates/:reference`, since the purge-approve response hands the reference back exactly once, in a toast).
- **Cancellation**: `POST /documents/:id/purge/cancel` at any point before execution.
- **30-day trash window / 7-day cooling period are hardcoded**, not tenant-configurable, by explicit decision (D12).

### 9.7 Legal hold

- **Trigger**: `POST /legal-hold` (case reference, custodian) then `POST /legal-hold/:id/add-documents`.
- **Effect**: every held document is frozen against archive/disposal/purge regardless of retention schedule — this is the **sole** freeze mechanism in the system; there is deliberately no separate "administrative hold" (D11) — a non-legal freeze (a migration, an internal review) uses a legal hold with an appropriately worded reference instead.
- **Release**: `POST /legal-hold/:id/release` requires both `closureRef` and `reason`.
- **Chain of custody**: `GET /legal-hold/:id/history` — every apply/release event, filtered efficiently by event-type first (not a full-table `LIKE` scan — a deliberate perf trade-off documented in the route file, see §28).

### 9.8 Forms submission through the engine

- **Trigger**: `POST /forms/instances` on an **active** template.
- **Steps**: multipart body (JSON data + optional per-field file uploads + an optional custom approval-chain override) → rendered via `@pdfme/generator` using the template's **frozen** `template_version` → stored (MinIO/local) → registered as a first-class `Document` → auto-submits into the unified approval engine as item type `FORM_INSTANCE` (same chain mechanics as §9.1).
- **Known parity gap (fixed)**: `createFormInstance`'s auto-submit failure used to be silently dropped by Sequelize's `toJSON()` before ever reaching the response — now returned as a sibling `approvalWarning` field and surfaced as a toast (CHANGELOG 2026-07-23).

---

## 10. Document Lifecycle

### 10.1 The 17-state machine (verified against `DocumentStateMachine.ts`)

`DRAFT`, `SCAN_PENDING`, `PENDING_REVIEW`, `IN_REVIEW`, `ON_HOLD`, `REJECTED`, `CHANGES_REQUESTED`, `DECLINED`, `APPROVED`, `PENDING_AUDIT`, `AUDITED`, `AUDIT_FLAGGED`, `PENDING_SIGNATURE`, `SIGNING_DECLINED`, `SIGNED`, `ACTIVE`, `SUPERSEDED`, `ARCHIVED`, `LEGAL_HOLD`, `DISPOSAL_PENDING`, `DISPOSED`, `PRESERVED`, `CANCELLED`, `TRASHED`, `QUARANTINED` — 25 named states total (the "17" figure in `README.md` counts the *core lifecycle* states, excluding the audit-stage/signing-stage additions layered on afterward by the unified engine; both figures are accurate for what they each describe, and the code comments make clear which states came from which design phase).

### 10.2 Transition graph (from `DocumentStateMachine.ts`'s `transitions` map)

| From | Allowed to |
|---|---|
| DRAFT | PENDING_REVIEW, IN_REVIEW, CANCELLED, ACTIVE (the last only reachable via `publishDraft()`, never the generic manual endpoint) |
| SCAN_PENDING | DRAFT, QUARANTINED, CANCELLED |
| PENDING_REVIEW | IN_REVIEW |
| IN_REVIEW | APPROVED, REJECTED, ON_HOLD, CHANGES_REQUESTED, DECLINED |
| ON_HOLD | IN_REVIEW, CANCELLED |
| REJECTED | DRAFT, CANCELLED |
| CHANGES_REQUESTED | IN_REVIEW, CANCELLED |
| DECLINED | IN_REVIEW, CANCELLED (D3 — revisable) |
| APPROVED | PENDING_SIGNATURE, PENDING_AUDIT, ACTIVE, ARCHIVED |
| PENDING_SIGNATURE | SIGNED, SIGNING_DECLINED |
| SIGNING_DECLINED | PENDING_SIGNATURE, CANCELLED |
| SIGNED | ACTIVE, PENDING_AUDIT, ARCHIVED |
| PENDING_AUDIT | AUDITED, AUDIT_FLAGGED |
| AUDITED | ARCHIVED, ACTIVE |
| AUDIT_FLAGGED | PENDING_AUDIT, CANCELLED |
| ACTIVE | ARCHIVED, SUPERSEDED, PENDING_SIGNATURE (subsystem-only — re-signing an already-active document) |
| SUPERSEDED | ARCHIVED |
| ARCHIVED | LEGAL_HOLD, DISPOSAL_PENDING, PRESERVED |
| LEGAL_HOLD | ARCHIVED |
| DISPOSAL_PENDING | DISPOSED |
| DISPOSED, PRESERVED, CANCELLED | *(terminal — no outbound transitions)* |
| TRASHED | DRAFT, ACTIVE, ARCHIVED, IN_REVIEW, APPROVED, CANCELLED *(restore target = whatever `preTrashStatus` recorded)* |
| QUARANTINED | ACTIVE, CANCELLED |

TRASHED is reachable from any non-terminal state (soft delete via `POST /:id/trash`), independent of the graph above.

### 10.3 Manual-transition permission allowlist (the C2 fix)

The generic `PATCH /documents/:id/status` endpoint does **not** allow every graph-valid transition — only ones explicitly listed in `MANUAL_TRANSITION_PERMISSIONS` (a strict `"FROM->TO"` allowlist): `APPROVED→ACTIVE`/`ARCHIVED`, `SIGNED→ACTIVE`/`ARCHIVED`, `AUDITED→ACTIVE`/`ARCHIVED`, `ACTIVE→ARCHIVED` (`document:archive`), `ACTIVE→SUPERSEDED` (`version:manage`), `SUPERSEDED→ARCHIVED`, `ARCHIVED→DISPOSAL_PENDING`/`PRESERVED` (`retention:manage`), `QUARANTINED→ACTIVE`/`CANCELLED`, `DRAFT→CANCELLED`/`REJECTED→DRAFT`/`REJECTED→CANCELLED`/`ON_HOLD→CANCELLED` (author housekeeping). Any transition **absent** from this map is refused on the manual endpoint entirely, because it is meant to be driven only by a subsystem (approval engine, audit stage, e-signing, legal hold, disposal worker) — this closes a real defect ("C2") where a holder of only `document:upload` could previously walk `DRAFT→IN_REVIEW→APPROVED→ARCHIVED` by hand, self-approving and completely bypassing the approval chain.

### 10.4 Lifecycle stages narrative

**Creation/Upload** → `DRAFT` (or `SCAN_PENDING` for >100MB uploads awaiting an async ClamAV scan, promoted to `DRAFT` by `ScanWorker`) → **Editing** (checkout/checkin, new versions) while `DRAFT` → **Submission** (`IN_REVIEW`) → **Review** (approval chain running) → **Approval or rejection paths** (§9.1/§9.2/§9.3) → **Signing** (if the type requires it) → **Distribution/Publication** (`ACTIVE`) → **Archiving** (`ARCHIVED`, possibly after `PENDING_AUDIT`/`AUDITED`) → **Retention** (`LEGAL_HOLD` freeze, or the natural `DISPOSAL_PENDING→DISPOSED` path, or `PRESERVED` for permanent-retention items) → **Retrieval** at any point via `GET /:id`/`GET /:id/download` subject to ACL. **Deletion**: only `DRAFT` documents may be hard-deleted directly (`DELETE /:id` — bypasses trash entirely, since an unpublished draft was never a managed record); everything else must go through Trash → 7-day cooling → maker–checker staged purge → `DISPOSED`.

---

## 11. Document Types, Metadata, Templates and Forms

### 11.1 Document types

`document_types` table drives per-type policy: `reapprovalPolicy` (`none`/`major_versions`/`all_changes` — D2, governs whether editing an already-approved document re-runs the chain), `auditPolicy` (`required`/`optional`/`never` — D5), `signingPolicy` (whether approval auto-triggers an e-sign ceremony — D8), plus `requiresApproval` (opt-out flag enabling the direct `publishDraft()` path). CRUD at `/document-types` (`doctype:read`/`doctype:manage`).

### 11.2 Metadata

Core fields live directly on `Document` (title, security classification, sensitivity label — Public/Internal/Confidential/Restricted, retention class, document date, organisation unit, OCR status/confidence, AI summary/suggested-metadata JSONB). Extended/custom fields live in `document_metadata`. AI-suggested metadata (`aiSuggestedMetadata` JSONB, populated by `AIWorker`'s extract job) can be applied field-by-field via `PATCH /documents/:id/metadata/apply-suggestion`.

### 11.3 Forms — templates and instances

Template lifecycle is **state-guarded** (`FormTemplate.status`): `draft → pending_approval → active → deprecated`, with `pending_approval`/`active` permitted to return to `draft`; any other transition raises `409 ERR-FORM-STATE-INVALID`. Templates carry a base PDF (uploaded via `POST /forms/templates/base-pdf`), an optional letterhead flag (migration `20260827000001`), and versioned content (`POST /forms/templates/:id/versions`). An **instance** is generated from an **active** template only, via `@pdfme/generator`, and is registered as a first-class `Document` carrying a **frozen** `template_version` — editing the template later never retroactively changes an already-filed instance's rendering contract. Template approval itself goes through the unified engine as item type `FORM_TEMPLATE`; instance approval as `FORM_INSTANCE`.

### 11.4 Letterhead / letter generation

Rendered with pdf-lib: letterhead asset, server-stamped date (never client-supplied — non-repudiation), a signatory block sourced from the approving user's profile (name, title, and an optional uploaded handwritten-signature image, D8c), and a QR code. Amharic text is rendered via an embedded, subset Noto Sans Ethiopic font (`backend/assets/fonts`, OFL-licensed); pure-Latin text uses Helvetica for a smaller file. `scripts/rasterize-letterhead.mjs` is the tooling for preparing letterhead art. **[GAP]** `StandardFonts` (pdf-lib's built-ins) are WinAnsi-only — before the Noto Sans Ethiopic embedding this meant Amharic rendered as `?`; this is now fixed for composed letters and cover sheets specifically, but any other PDF-generation path that hasn't adopted the embedded font would still hit the same limitation.

### 11.5 Versioning and relationships

Every document version is immutable once written (`document_versions`, one row per version — never mutated, only superseded). `currentVersion`/`latestVersionId` on `Document` point at the head. Rollback (`POST /:id/rollback`) creates a **new** version whose content matches an earlier one, rather than deleting history. The version-diff endpoint (`GET /:id/versions/diff`) does a word-level LCS diff between any two versions' extracted text, capped at 5000 words/version to bound the O(m·n) DP table.

---

## 12. Approval and Workflow Engine

Two distinct, both-live engines exist — do not conflate them:

### 12.1 The unified approval engine (`modules/approvals/`) — the current, actively-developed engine

Full detail already covered in §9.1–9.2 and §6.3; this subsection is the structural summary.

- **Chain templates** (`approval_chain_templates`): admin-defined per document type / form template, an ordered list of steps, each specifying actor (named person or role), step kind (Review/Approve), deadline, and a `locked` flag.
- **Author completion (D1)**: at submit, the author sees the pre-filled chain and personalizes the unlocked parts — swap role for named person, add optional steps, reorder optional steps. Locked steps are immutable.
- **Sequential execution**: exactly one `PENDING` `approval_step` at a time per chain (DB-enforced), each naming either a user or a role, never both/neither (DB CHECK).
- **Decisions**: `APPROVE` / `REQUEST_CHANGES` / `DECLINE` — decline's comment is mandatory.
- **Serves**: `DOCUMENT`, `FORM_TEMPLATE`, `FORM_INSTANCE`. Letters keep their **own** chain implementation (`letter_approval_steps`), not this engine — a deliberate scope boundary (letters had a proven implementation predating the unified engine and migrating them was deferred, per SYSTEM-DECISIONS' "still open" list).
- **Post-approval routing**: per-type `auditPolicy` and `signingPolicy`, both described above.
- **Concurrency control**: mirrors letters — a chain row lock plus status-guarded step updates, so two concurrent decision attempts on the same step cannot both "win".
- **SLA**: `ApprovalSlaWorker` sweeps overdue PENDING steps and flags `sla_breached_at` (a real fix — the equivalent legacy workflow SLA sweeper only ever queried the legacy `workflow_tasks` table and never saw unified-engine steps at all, so a step assigned to an unavailable approver used to blow its SLA with zero escalation and zero visibility).

### 12.2 The legacy workflow engine (`modules/workflow/`) — still live, narrower scope

A `WorkflowDefinition` is a named, versioned, JSON-encoded list of `WorkflowStage`s (`{stageNumber, name, assignedRole, slaDurationHours, slaBusinessHoursOnly, escalationRole?, parallelApproval?}`), optionally scoped to a `documentTypeId` (unscoped = applies to any type), flagged `isDefault`/`isActive`. `POST /documents/:id/workflow/start` looks up the type's active default definition, creates a `WorkflowInstance` at stage 1, opens the first `WorkflowTask` for whichever role the stage names — matched against a user's **full `roles` array**, not a single legacy role string (a Session-12 RBAC fix). SLA deadlines computed from `slaDurationHours` (`slaBusinessHoursOnly` walks only Mon–Fri, `BUSINESS_HOURS_START`/`END`, `BUSINESS_TIMEZONE=UTC`); a breached task is flagged `isSlaBreach:true` by `WorkflowWorker`, not forced into a dead-end status, so it stays decidable. **`escalationRole` is captured in the schema but not yet acted on by the worker** — no automatic reassignment. This is a stated, documented gap, not a silent bug.

Definition CRUD is reachable from **Operations → Workflow Definitions** (`WorkflowDefinitionsPanel`) — a stage builder with add/remove/reorder, role pickers sourced from `GET /roles`, SLA-hours input, business-hours/parallel toggles. Before this UI existed, the table was only configurable by editing seed data or writing rows directly.

### 12.3 Which engine handles what, today

| Item type | Engine |
|---|---|
| Document (generic approval) | Unified approval engine (§12.1) |
| Document (legacy per-department workflow stages, where still configured) | Legacy workflow engine (§12.2) — both can coexist on the same document type in principle, though the unified engine is the actively maintained one |
| Form Template / Form Instance | Unified approval engine |
| Letter (CAMS) | Letters' own chain (`letter_approval_steps`) |

### 12.4 Audit stage and signing-stage state machines

Both described fully in §9.2/§9.3. Their state additions to the document lifecycle (`PENDING_AUDIT`/`AUDITED`/`AUDIT_FLAGGED`, `PENDING_SIGNATURE`/`SIGNING_DECLINED`/`SIGNED`) are part of the single `DocumentStateMachine.ts` graph in §10.2 — they are not a separate state machine bolted on, they're additional nodes/edges in the same one.

### 12.5 Failure scenarios

- **Stuck step** (assignee deactivated, role unstaffed): admin `reassign` (unified engine) or the letters equivalent reassign endpoint — both require an elevated permission enforced in the service layer, not just the route.
- **Offboarding a user with pending work** ("M8 sweep"): a deactivation sweep runs behind a **savepoint** (`runInSavepoint`, `shared/transaction.ts`) specifically so a DB error inside the sweep cannot abort the whole request transaction and roll back the deactivation itself — the security action (deactivating the user) must never be blocked by a failure in the housekeeping sweep that follows it.
- **SLA breach with no escalation acted on** (legacy engine's `escalationRole`): visible via the `isSlaBreach` flag and notifications, but requires a human to actually reassign — see §12.2.

---

## 13. Search

### 13.1 Active production configuration **[CFG]**

`SEARCH_ENGINE` selects between `meilisearch` and `postgres` (default). **On the live Example Corp server today, this is `postgres`** — Meilisearch is not installed there (§1.7). Both are real, maintained code paths, not one primary + one deprecated stub.

### 13.2 Meilisearch path

`infrastructure/search/meilisearch.ts` — per-tenant indexes (`ensureTenantSearchIndex`), health-probed at boot (`ensureMeilisearchHealthy`) and by `/operations/health`. Indexing is asynchronous: a document create/update/OCR-completion enqueues a `SEARCH_INDEX` outbox event, dispatched to `SearchWorker`, which caches "known-good tenant index" state for an hour to avoid three Meilisearch API round-trips per document. `SEARCH_INDEX` outbox events never expire (§2.6) — a temporarily-down Meilisearch never silently loses an indexing job, it just backs up until Meilisearch comes back.

### 13.3 PostgreSQL fallback (production-active path)

`modules/search/search.service.ts` — `ILIKE`-based queries directly against `documents`/`document_metadata`/`document_type`/`department`, filtered by the same ACL-aware read-scope logic every document listing uses (`resolveACL`, `userHasPermission(ACL_BYPASS_ADMIN)` short-circuit for admins). Supports the same filter surface as the Meilisearch path conceptually (department code, doc-type code, status, sensitivity, legal-hold flag, date range, retention class) but without ranking/relevance scoring or fuzzy matching — a straightforward substring match. Facets are computed via separate grouped `COUNT` queries when `facets=true`.

### 13.4 Query flow (either backend)

`GET /search?...` → `search:read` → build filter object from query params → ACL-aware execution → results filtered post-query for anything the ACL layer would deny (not just pre-filtered by department, since a per-document DENY can override an otherwise-visible department) → response. `search:scope_all` widens the department scope for oversight roles (RECORDS_OFFICER, AUDITOR).

### 13.5 Saved searches

`saved_searches` table — `POST/GET /search/saved`, `DELETE /search/saved/:id`, all `search:read`.

### 13.6 Failure behavior

Meilisearch selected but unreachable: `/operations/health`'s probe reports `meilisearch: error` (2-second timeout, not a hang); actual search requests against a down Meilisearch will error at the query layer — there is **no automatic fallback from Meilisearch to Postgres at query time**; the fallback is a deployment-time choice (`SEARCH_ENGINE` env var), not a runtime degrade. Contrast with storage (§14), which *does* runtime-degrade.

### 13.7 Performance considerations

Postgres `ILIKE` has no dedicated text-search index in this schema (no `pg_trgm`/GIN index on document title/metadata) — acceptable at the current single-tenant, moderate-document-count scale; would need attention before it stopped being **[GAP]** at meaningfully larger corpus sizes. Meilisearch, when selected, is the intended answer to that scaling question.

---

## 14. File Storage

### 14.1 Storage architecture

`infrastructure/storage/` defines a `StorageAdapter` interface with two implementations — `local.ts` (filesystem) and `minio.ts` (S3-compatible object storage) — selected at boot by `STORAGE_DRIVER` (`local` default, `minio` **[CFG]**). `storage/index.ts` does the driver selection and exposes `initializeStorage()` (bucket/directory existence check at boot) and `getStorageAdapter()`.

### 14.2 Current production driver

**Local disk**, on the reference production server — `STORAGE_LOCAL_PATH` pointed at `<storage-folder>/dms-documents`, deliberately **outside** the git checkout (verified by the deploy-checklist item C16, which checks the backend startup log line `StorageAdapter: using local filesystem` names that exact base path). MinIO is a fully supported, tested alternate driver (used by the Docker Compose path) but is not what production runs.

### 14.3 Path/configuration

`STORAGE_LOCAL_PATH` **must be absolute** — it defaults to `<cwd>/storage/dms-documents`, and `cwd` depends on how the process was launched; a `.bat`/scheduled-task launcher started from the wrong directory silently creates a brand-new, empty store with no error at boot (an empty directory is a perfectly valid one), and every existing document then 404s. Changing this value does **not** move existing files — the store's contents are portable (storage keys are relative to the root) but the location is not automatic; the operator must copy the directory across, verify, then repoint.

### 14.4 Naming / directory structure

Storage keys are relative paths generated per document/version (not exposed as a stable public contract in the docs read this session — treated as an internal implementation detail of `StorageAdapter`). MinIO buckets: `MINIO_BUCKET_DOCUMENTS` (default `dms-documents`), `MINIO_BUCKET_ARCHIVE` (default `dms-archive`) — the Docker Compose path additionally enables **bucket versioning** on both via a `minio-init` one-shot, giving overwrite/delete protection independent of the application layer.

### 14.5 Encryption relationship (see §26.5 for full crypto detail)

Every stored file version is AES-256-GCM encrypted with its own per-**version** Data Encryption Key before it ever reaches the storage adapter — the adapter itself only ever sees/writes ciphertext. Decryption happens in `documentCrypto.ts`'s `fetchAndDecrypt`, called by the download/preview/OCR/e-signing/AI code paths, never by the storage adapter itself.

### 14.6 Upload / download flow

Upload: multipart (`multer.memoryStorage()`, capped at 25MB — `MAX_BUFFERED_UPLOAD_BYTES`) for the standard route, or the resumable **tus** protocol (`@tus/server` + `@tus/file-store`, no upper size limit, streams to disk) for anything larger — mounted **before** `express.json()` in `app.ts` so tus can read the raw binary PATCH body. Both paths converge on the same `documentCrypto`/storage pipeline once the file is fully received. Download: `GET /documents/:id/download` streams (or buffers, for smaller files) the decrypted content with a `pipeline()`-based stream that handles a mid-stream failure gracefully (destroys the connection rather than attempting a second, invalid response if headers were already sent).

### 14.7 File validation / size limits

- 25MB buffered-upload ceiling (`documents.routes.ts`, `esigning.routes.ts` upload endpoints) — a clear `413 ERR-FILE-TOO-LARGE` naming the tus alternative, not a generic 500.
- Magic-byte MIME sniffing (`file-type` package) rather than trusting the client-declared content type.
- ClamAV scanning **[CFG]** — synchronous for smaller files, async via `ScanWorker` (BullMQ) for files >100MB (documents created in `SCAN_PENDING` and promoted to `DRAFT` on a clean scan result, or `QUARANTINED` on a hit).
- Files >100MB always route through the async scan path regardless of storage driver.

### 14.8 Security

A previously-real vulnerability, now closed: `/storage/files`/`/storage/download` legacy routes let *any* caller holding the blanket `document:read` permission enumerate and download every file under the storage root, across every tenant and department, with no per-resource ACL check and only a path-traversal guard. Removed outright (not tenant-scoped, since grep confirmed the frontend never called either route and the real download path — `documents.service.ts`'s `fetchDocumentFile` — already enforced per-document access). The one sanctioned download path today (`GET /documents/:id/download`) always runs `requireACL({resourceType:'document', permission:'document:read'})`.

### 14.9 Backup / restore

Covered in §25. Storage backup for the native deployment is `scripts/storage-backup.ts`; for the Docker path, `deploy/backup/` scripts plus MinIO's own bucket versioning.

### 14.10 Production-specific constraints

Local-disk storage means DMS's document corpus grows the underlying disk directly — there is no automatic tiering to cheaper storage the way a MinIO/S3 lifecycle policy could provide. The `STORAGE_LOCAL_PATH` comment in `config/env.ts` explicitly names "pointing it at a second disk" as the intended lever for outgrowing the system drive — a config change, deliberately, not a code change or filesystem junction, "or nobody will do it safely under pressure."

---

## 15. OCR and Document Processing

### 15.1 Architecture

`OCRWorker` (`infrastructure/queue/workers/OCRWorker.ts`) consumes the `OCR` outbox channel. Two distinct extraction paths depending on source format:

1. **Digital PDFs** (text already embedded): exact text-layer extraction via `pdfjs-dist` — no OCR guesswork needed, fast, and yields perfect text (not OCR-confidence-scored, since there's nothing probabilistic about it).
2. **Image-only scans / non-searchable PDFs**: rasterized page-by-page via `sharp`/`@napi-rs/canvas` into images, then run through `tesseract.js`'s OCR engine, capped at **10 pages** per document (a documented ceiling — a large scanned book is not the target use case).

Language detection (`franc`) runs over the extracted text to tag the document's detected language, informing downstream metadata.

### 15.2 Processing pipeline / queue behavior

Document upload or a letter's incoming-scan registration enqueues an `OCR` outbox event → dispatched by the outbox poller to a BullMQ job on `OCRWorker`'s queue → the worker fetches and decrypts the file (`documentCrypto.fetchAndDecrypt`), extracts text by whichever path applies, writes it to `document_versions.extractedText`, updates `Document.ocrStatus`/`ocrConfidenceScore`, and — post-commit — enqueues a `WEBSOCKET` event so the UI updates live. `OCR` outbox events **never expire** (unlike EMAIL's 72-hour ceiling) — an OCR backlog from a down worker process is always eventually worked through, never silently abandoned. On worker boot, any accumulated `PDF_PENDING` backlog from before the worker started is requeued once.

### 15.3 Supported formats

PDF (digital and scanned), and whatever image formats `sharp` decodes (feeding into the same tesseract path as rasterized PDF pages).

### 15.4 Failure handling / retry

Standard BullMQ retry/backoff (3 attempts, exponential — the same `createQueue()` defaults as every other queue in this system, `queues.ts`). `recordOcrOutcome()`/`ocrProcessingDuration` (`infrastructure/metrics.ts`) track completed/failed/skipped counts, surfaced at `GET /operations/pipeline-metrics` — added specifically because the OCR/AI pipeline previously had zero visibility beyond raw pino log lines.

### 15.5 Storage interaction / RLS note

The worker's own file header carries a specific, non-obvious warning: `documents` has RLS with **no** unset-GUC escape valve (unlike `document_versions`, which currently has none at all), so a bare read/write inside the worker would silently touch zero rows the day the DB role switches to the restricted `edams_app` role — `tenantId` from the job payload is threaded through `withWorkerTenantContext()` specifically to avoid this; older queued jobs from before this field existed fall back to running with no tenant context (matching pre-fix behavior rather than crashing them retroactively).

### 15.6 Operational troubleshooting

- **Symptom**: a document sits at `ocrStatus: pending` indefinitely. **Check**: `GET /operations/pipeline-metrics`'s `ocr.available` — if `false`, no OCR job has ever completed in this process (cross-process Redis-backed counters, since the worker runs in a separate process from the API — an in-process read here would always show 0). **Check**: `GET /operations/outbox` for a stuck `OCR`-channel row with `attempts` near the max.
- **Symptom**: Amharic/non-Latin OCR text looks wrong. `tesseract.js`'s language pack selection depends on `franc`'s detection being correct on the raw (pre-OCR) extracted-text guess; a scanned image with no prior text layer relies purely on tesseract's own recognition quality for that language.

---

## 16. PDF Generation

Three independent PDF-generation pipelines exist, each for a different purpose:

| Pipeline | Library | Purpose | Notes |
|---|---|---|---|
| Letters (`modules/letters/letterPdf.ts`) | pdf-lib + @pdf-lib/fontkit | Composed outgoing letters, incoming-scan cover sheets | Letterhead, server-stamped date, signatory block (name/title/optional signature image), QR code; embedded Noto Sans Ethiopic for Amharic, Helvetica for Latin |
| Forms (`modules/forms/`) | @pdfme/generator + @pdfme/common + @pdfme/schemas | Rendering a filled form instance from its template's field schema | Frozen `template_version` at render time |
| E-signing PAdES copies (`modules/esigning/esignPades.ts`) | @signpdf/signpdf + @signpdf/signer-p12 + @signpdf/placeholder-pdf-lib | Flattened, cryptographically byte-range-signed PDF of a completed signing ceremony | Best-effort, post-commit, requires `ESIGN_P12_B64` (a base64 PKCS#12 cert); filed as a new document version |

### 16.1 Fonts/assets

`backend/assets/fonts` — shipped in the Docker image and copied onto native deploys; must exist on disk relative to wherever the process's cwd resolves assets from (same class of footgun as `STORAGE_LOCAL_PATH` — cwd-dependence).

### 16.2 Errors / performance

PDF generation runs synchronously inside the request for letters/forms of normal size; no async queue exists for PDF rendering itself (only for OCR and PAdES-signing, which are queued/post-commit respectively). A pathologically large form template or letter body is therefore a direct request-latency risk — not currently mitigated by a size cap in the reviewed code paths. **[GAP — noted, not measured against a real incident]**

---

## 17. Electronic Signing

Full workflow narrative in §9.3; API surface in §6.5. This section covers the architecture/security detail requested separately.

### 17.1 Two signing subsystems, one parked

- **E-signing (`modules/esigning/`) — the live, actively-used subsystem.** Signature-request "envelopes": recipients (internal or external), field placements, serial/parallel ordering, completion tracking, expiry. This is what SYSTEM-DECISIONS.md D8 means by "signed."
- **PKI subsystem — deliberately parked (D8d).** A self-managed CA keypair (persisted to `backend/storage/.ca-keypair.json`) and real RSA-signature capability exist in the codebase, **unwired** — not deleted, not revived. Kept explicitly as a head start for a possible future PAdES build with real cryptographic, Acrobat-verifiable signatures embedded in PDF byte ranges. No investment beyond keeping it compiling.

### 17.2 PKCS#12 handling

`ESIGN_P12_B64` (base64-encoded PKCS#12 bundle) + `ESIGN_P12_PASSPHRASE` — used only for the **PAdES flattened-copy** step (§17.4), which is a distinct thing from the parked PKI subsystem above. `scripts/generate-esign-cert.js` generates a self-signed one for dev/testing; a real org certificate is expected in production. **Never committed** — lives only in `.env.production`/`.env.prod` (gitignored).

### 17.3 Signing flow (recap with security-relevant detail)

- **Non-repudiation evidence**: the signer's recorded IP comes from `req.ip` (filtered through Express's `trust proxy` setting), **never** a raw `x-forwarded-for` header read directly — a real, fixed vulnerability: any signer (and, on the external variants, anyone holding the emailed access token) could otherwise put an arbitrary address into their own legal signing record just by sending that header, since a header is fully client-controlled unless filtered through a trusted-proxy boundary.
- **Ordering enforcement**: `serial` mode returns `409 ERR-SIGNING-OUT-OF-ORDER` if a recipient tries to sign before every lower-`order_index` recipient has.
- **Internal vs external authorization**: internal signing routes require a valid JWT *and* the service-layer check "caller is the named recipient" (not gated by a broader `signing:manage` permission, since the assigned recipient may hold only `signing:read`); external routes require a valid, unexpired `access_token` instead of any JWT at all, and are deliberately mounted on the **public** router (§2.4) since external signers have no DMS account.

### 17.4 PAdES completion

On ceremony completion, `esignPades.ts` flattens the placed fields into the PDF, adds a certificate-of-completion page, and applies a byte-range PKCS#12 signature (RFC 3161-shaped, via `@signpdf/*`) — filed as a **new document version**, best-effort and post-commit (a failure here does not fail the ceremony itself; the ceremony's own completion record is the authoritative evidence regardless).

### 17.5 Certificate lifecycle / rotation

No automatic rotation mechanism for `ESIGN_P12_B64` reviewed in this session — treated as a manually-managed operational secret (rotate by generating a new cert and updating the env var; historical PAdES-signed PDFs remain valid under whatever cert signed them, since the signature is embedded in that specific file, not re-verified against a "current" cert at read time).

### 17.6 Verification

`GET /documents/:id/sign/verify` — verifies a document's e-signing status/history against `signature_records`. External PAdES verification (Acrobat/any PDF-signature-aware reader) is a property of the embedded byte-range signature itself, independent of DMS.

### 17.7 Security considerations

- Access tokens for external signers are 7-day TTL, single-purpose (scoped to one request+recipient), never a general-purpose credential.
- `markRecipientViewed` never downgrades an already-signed/declined recipient's status — a "viewed" ping cannot un-sign or un-decline something.
- Handwritten signature images (D8c) are explicitly stated as **cosmetic only** — "the underlying guarantees are unchanged" — they make the PDF look conventionally signed but carry no additional cryptographic weight beyond what the ceremony/PAdES step already provides.

---

## 18. Notifications

### 18.1 Channels

- **In-app** (`notifications` table): `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`.
- **Realtime push** (Socket.IO, `infrastructure/websocket/`): fanned out via `enqueueWebsocketEvent()` → `WEBSOCKET` outbox channel — deliberately short max-age (a stale realtime push is worse than none), tenant/department-scoped rooms, Redis adapter for multi-instance readiness.
- **Email** (`EMAIL` outbox channel + a separate dedicated `EmailWorker`/`EMAILS` BullMQ queue for higher-stakes externally-visible sends that need real attachments — e.g. a dispatched letter's PDF+QR cover sheet to an external recipient): bodies **always** come from `infrastructure/email/templates.ts`'s `renderEmail(type, payload)` registry — hand-built inline email HTML/text is a stated anti-pattern, never done.
- **Push (mobile/browser push)**: not implemented. **[GAP — not requested in scope, no code path found]**

### 18.2 Notification type catalogue (from `notifications.service.ts`)

Lock-expiry warnings, purge-approval-required, audit-integrity-failure, virus-detected, scan-completed, storage-quota-warning, HSM-unavailable, key-rotation-complete, CAMS letter events (step-pending, registered, approved, returned, cancelled), unified-approval events (step-pending, changes-requested, declined, completed, cancelled, SLA-breach), audit-stage events (assigned, passed, flagged), offboarding-sweep (`ASSIGNEE_DEACTIVATED`), outbox dead-letter alerts, AI-processing-skipped (with a documentId deep-link, added specifically because the previous silent no-op left zero user-facing signal when a document had no usable OCR text to summarize), e-signing (request-assigned, request-declined, and completion — the last two both explicitly fixed to also notify the **sender**, not just realtime-only, after a 2026-08-11 data-flow audit found neither had been reaching the request's creator by any persistent channel).

### 18.3 Triggers / fan-out

`fanOut()` (`notifications.service.ts`) is the shared helper every producer calls — writes the DB notification row and enqueues the realtime push in one call, inside the same transaction as whatever domain event triggered it (via the outbox pattern, §2.6).

### 18.4 Retry / failure handling

Same outbox retry semantics as every other channel (§2.6): 3 attempts, exponential backoff, dead-lettered past that with an `OUTBOX_DEAD_LETTER` admin-facing notification. `retire-stale-email-backlog.ts` (test-scripts, despite the "verify" location — this one is closer to an ops utility) exists to clear an aged EMAIL backlog manually if one ever accumulates past the point of being useful.

### 18.5 Configuration

`SMTP_HOST`/`PORT`/`SECURE`/`USER`/`PASS`, `EMAIL_FROM`. `EMAIL_REDIRECT_TO` — a **dev-only** safety valve that redirects every outbound email to one address (intended recipients preserved in the subject/body) so testing against a real SMTP relay never spams real colleagues/seeded addresses; **hard-refused at boot in production/staging** (§22, §26.1) because it previously diverted every real notification, approval request, and dispatched letter silently in a live launch.

---

## 19. Background Jobs and Workers

All 15 workers live in `backend/src/infrastructure/queue/workers/`, started together by `startWorkers()` (`workers/index.ts`) in the dedicated **worker process** (`bin/worker.ts`) in production, or in-process alongside the API in development (`ENABLE_QUEUE_WORKERS=true` default). Every queue is wrapped with `attachErrorLogger()` (`queues.ts`) — a BullMQ `Queue`/`Worker` `'error'` event with no listener otherwise kills the whole Node process silently with nothing logged, which was the root cause of a class of "mysterious backend crashes" before this was understood.

| Worker | Queue name | Trigger | Purpose | Retry/failure |
|---|---|---|---|---|
| `OCRWorker` | (OCR outbox channel) | Document create / letter scan registration | Text extraction (pdfjs exact / tesseract OCR) | 3× backoff; boot-time requeue of stuck `PDF_PENDING` backlog |
| `SearchWorker` | (SEARCH_INDEX outbox channel) | Document create/update/OCR-complete | Meilisearch indexing | 3× backoff; never expires in outbox |
| `AIWorker` | `AI_PROCESSING` | `POST /ai/documents/:id/summarize`\|`extract` | Summarization / metadata extraction via provider-agnostic `llmClient` | Feature-flag-gated (fails closed if tenant hasn't consented); writes `AI_OPERATION` audit events |
| `EmailWorker` | `EMAILS` | Higher-stakes externally-visible sends needing real attachments | Outbound email with attachments | 3× backoff |
| `ScanWorker` | (ScanJobPayload queue) | Upload >100MB | Async ClamAV scan | On hit → `QUARANTINED` + notification |
| `WorkflowWorker` | `WORKFLOW_SLA` | Periodic sweep | Legacy per-document workflow SLA breach detection | Flags `isSlaBreach`, no auto-reassignment |
| `ApprovalSlaWorker` | `APPROVAL_SLA` | Periodic sweep | Unified-engine approval-step SLA breach detection | Flags `sla_breached_at`, fans out a notification |
| `RetentionWorker` | `RETENTION_ENGINE` | Daily sweep | `ARCHIVED → DISPOSAL_PENDING` per policy, skipping legal holds | — |
| `RetentionPurgeWorker` (3 sub-workers) | cold-storage tiering (02:00), purge-cooling (03:00), disposal-notification | Daily CRON | Two-stage purge: trash→PurgePending→7-day cooling→certified destruction | `executePurge()` post-commit storage deletion |
| `LockWorker` | `lock-maintenance` | Hourly | Auto-release expired document locks, send expiry warnings | — |
| `EsigningExpiryWorker` | `ESIGNING_EXPIRY` | Periodic sweep | `sent`/`partially_signed` past `expiresAt` → `expired` | Also lazily enforced on the hot `signDocument()` path |
| `AuditChainWorker` | `audit-chain-verification` | Daily 04:00 | Full hash-chain integrity verification | Raises `AUDIT_INTEGRITY_FAILURE` notification on any break |
| `TusUploadCleanupWorker` | `tus-upload-cleanup` | Every 6 hours | Sweeps abandoned/incomplete tus uploads from `storage/tus-uploads` | 24h upload expiration window |
| Outbox poller | (not a BullMQ worker — a `setInterval`-style poller) | Every 5s (`OUTBOX_POLL_INTERVAL_MS`) | Dispatches `outbox_events` to their real channel handler | 3 attempts, per-channel max-age (§2.6) |

### 19.1 Monitoring / operational controls

`GET /operations/outbox` (pending/failing rows), `POST /operations/outbox/:id/retry`, `GET /operations/pipeline-metrics` (OCR/AI outcome counts + durations, cross-process via Redis-backed counters since workers run in a separate OS process from the API in production). No per-worker pause/resume UI beyond BullMQ's own tooling (not exposed in DMS's admin panels).

---

## 20. Frontend

### 20.1 Application architecture

Next.js 16, App Router, TypeScript, React 19. Route groups: `(auth)` for unauthenticated flows, `dashboard/` for the main authenticated app, `operations/` for the admin/ops panel host, `settings/` for user settings, plus two standalone public pages (`verify/`, `sign/[requestId]/[recipientId]/`) and an OIDC callback receiver (`auth/callback/`).

### 20.2 Page map (`app/`, verified file listing)

| Route | Purpose |
|---|---|
| `(auth)/login` | Login (dev quick-pick buttons for seeded accounts when `LOCAL_JWT_MOCK`) |
| `(auth)/select-role`, `(auth)/select-tenant` | Two-phase auth completion (§7.1) |
| `auth/callback` | OIDC redirect receiver |
| `dashboard/page.tsx` | Main dashboard/stats |
| `dashboard/browse` | Document repository browser (hierarchy sidebar + document pane) |
| `dashboard/documents`, `dashboard/documents/[id]` | Document list / detail |
| `dashboard/upload` | Upload wizard |
| `dashboard/files` | "My Files" view |
| `dashboard/trash` | Recycle bin |
| `dashboard/search` | Search page |
| `dashboard/mywork` | Unified "My Work" inbox (approvals + audit reviews) |
| `dashboard/bundles`, `dashboard/bundles/[id]` | Document bundles |
| `dashboard/forms`, `.../fill`, `.../submissions`, `.../templates` | Forms engine UI |
| `dashboard/letters`, `.../new`, `.../register`, `.../[id]` | CAMS correspondence UI |
| `dashboard/signing`, `.../pending`, `.../sent`, `.../completed` | E-signing queues |
| `dashboard/reports` | Compliance reports / analytics dashboard |
| `dashboard/storage` | Storage analytics |
| `dashboard/notifications` | Notification center |
| `dashboard/ai` | AI chat assistant |
| `operations/page.tsx` | Admin/ops panel host — every feature panel (`SystemPanels`, `AuditPanels`, `WorkflowPanels`, `RecordsPanels`, `ManagerHub`, hierarchy browser, CRUD panels, etc.) renders here |
| `settings/page.tsx` | User settings (2FA, profile, signature image, notification prefs) |
| `sign/[requestId]/[recipientId]` | External e-signing page (access-token based, no login) |
| `verify/page.tsx` | Public CAMS QR-verification page, no login |
| `page.tsx` (root) | Redirect logic |

### 20.3 State management

- **Zustand** — `auth.store.ts` (persisted to `localStorage["dms-auth"]`: access token, user, permissions, current tenant), `ui.store.ts` (theme, sidebar state).
- **TanStack Query** — every `features/*/hooks.ts` file wraps `apiClient` calls in `useQuery`/`useMutation`, giving cache invalidation, retry, and loading/error state uniformly across the app.

### 20.4 API communication

`shared/lib/apiClient.ts` (axios instance) — attaches `Authorization: Bearer <accessToken>` automatically, and implements a **401 → refresh → retry** interceptor: on a 401, it calls `POST /auth/refresh` (cookie-based) once, and if that succeeds, retries the original request transparently; if refresh also fails, it redirects to login. Base URL comes from `NEXT_PUBLIC_API_BASE_URL` — baked in at **build** time (Next.js `NEXT_PUBLIC_*` semantics), not runtime, which is why production builds must set it correctly at build time (§22, §23) rather than relying on a runtime env file.

### 20.5 Authentication / authorization on the frontend

`AuthGuard` (wraps the app, checked in `ARCHITECTURE.md`'s CAMS section for its public-path exemption list — `/verify` is explicitly listed there to skip the logged-in redirect). `usePermissions()` exposes `can(permission)`; `<PermissionGate permission="...">` conditionally renders. Nothing in the frontend string-matches a role name for authorization — consistent with the backend's own rule (§8.5).

### 20.6 Forms / validation

Each feature module owns its own form components and client-side validation; no single shared form-library convention was identified as universal across all 18 feature directories in this session's review — validation is ultimately re-enforced server-side regardless (Zod schemas in several route files, e.g. `letters.routes.ts`'s `listQuerySchema`, `orgUnits.routes.ts`'s `createSchema`/`updateSchema`).

### 20.7 Error handling / loading states / notifications

`react-hot-toast` for transient success/error messages; TanStack Query's built-in `isLoading`/`isError` states drive per-panel loading skeletons and error banners; the `apiClient` interceptor centralizes 401 handling so individual components don't each reimplement it.

### 20.8 Responsive behavior

`shared/components/DataTable` explicitly supports a mobile card-view fallback alongside its table rendering — the one component pattern in this codebase's docs that calls out responsive design directly. The `HierarchyTreeBrowser`'s compact/sidebar variant uses a tighter indent scale specifically for 13–14" laptop viewports (a fixed regression noted in `ARCHITECTURE.md`).

### 20.9 Accessibility

Radix UI primitives (`@radix-ui/react-dialog`, `-dropdown-menu`, `-tooltip`) provide the accessible-by-default building blocks for modals/menus/tooltips app-wide.

### 20.10 Performance

`npm run perf` (frontend `package.json`) — builds and serves the standalone output on a dedicated port (7199) for performance profiling separate from the normal dev/start ports.

### 20.11 Build process

`next build` (App Router, `output: "standalone"`). The standalone build's real entry point is a **nested** `server.js` whose depth depends on where Next infers the workspace root, and it does not copy `.next/static`/`public/` into the standalone folder — `frontend/scripts/start-standalone.cjs` exists specifically to paper over this and produce a working `npm run start`. Starting `server.js` directly gets an app that boots and then 404s every stylesheet.

### 20.12 Environment configuration (build-time contract)

| File | When read |
|---|---|
| `frontend/.env.development` | Only when `NODE_ENV=development` |
| `frontend/.env.production` | Baked into the build at `next build` time |
| `frontend/.env.local` | **Must not exist.** Next loads it in *both* modes and ranks it above `.env.production`, silently baking a dev value (`localhost`) into the production bundle. The build **refuses outright** when it detects this file (`shared/lib/apiConfig.ts`) — deliberately hard, not a warning. |

Required at build time for a real production build: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SOCKET_URL`, optionally `NEXT_PUBLIC_BASE_PATH` (`/dms` when served under a path prefix on the shared platform). The frontend **refuses to build** without an explicit `NEXT_PUBLIC_API_BASE_URL` rather than silently falling back to a hardcoded `localhost` value — a fix specifically because that fallback string used to be copy-pasted across 7 different files, any one of which could point a misconfigured deployment at the wrong host.

---

## 21. Backend

### 21.1 Application bootstrap (`main.ts` — API process)

`setupLogger()` → `assertProductionRuntimeRequirements()` (throws before anything else in prod/staging if config is unsafe, §22.4) → `assertRedisVersion()` (hard floor ≥ 6.2) → conditionally `startWorkers()` if `ENABLE_QUEUE_WORKERS` (dev-only in the real deployment topology — production explicitly sets this false, §2.9) → `initModels()` + `connectDB()` → register pool metrics source → `Promise.all([initializeStorage(), ensureMeilisearchHealthy(), reportAntivirusReadiness(), reportKekReadiness()])` (parallel, independent readiness checks — none blocks on another) → `createApp()` → `http.createServer(app)` → `initializeSocket(server)` + `initializeGateway()` → `server.listen(PORT, HOST)` → conditionally `startOutboxPolling()`.

Graceful shutdown on `SIGTERM`/`SIGINT`: stop outbox polling, close the HTTP server (stop accepting new connections, let in-flight ones finish), close the Socket.IO layer, close all workers (if running in-process), close the Sequelize pool — all via `Promise.allSettled`, bounded by a 10-second forced-exit timeout so a hung close can't block a restart indefinitely.

`process.on('uncaughtException'/'unhandledRejection')` — a last-resort safety net that logs full diagnostics (not silence) before draining via the same shutdown path. Explicitly documented as **not** an attempt to keep the process alive afterward (Node's own guidance: process state is undefined once `uncaughtException` fires) — it exists purely so a crash is never a silent, undiagnosable process exit, which is exactly the failure mode a missing BullMQ error listener used to produce before `attachErrorLogger()` existed.

### 21.2 Worker process bootstrap (`bin/worker.ts`)

Nearly identical shape, minus the HTTP server: `setupLogger()` → `assertProductionRuntimeRequirements()` → `assertRedisVersion()` → `initModels()` + `connectDB()` → `startWorkers()` → the same graceful-shutdown/uncaught-exception safety net. Deliberately a **separate** process from the API in production specifically so a worker-side native crash (the 2026-08-28 PDF-rasterization segfault) cannot take down live API traffic.

### 21.3 Middleware (order matters — see `app.ts`, full listing in §2.1)

trust-proxy config → helmet (CSP conditional on `ENABLE_API_DOCS`) → cors → compression → cookie-parser → requestId/requestLogger/metrics → IP rate limiters (auth/upload/global tiers) → tus handler (pre-JSON-parsing) → `express.json`/`urlencoded` → unauthenticated `/health` + JWKS + optional public `/metrics` → cache-control → `v1Routes` → error handler (always last).

### 21.4 Routing / controllers / services

Routes are transport-only; all logic lives in `*.service.ts` (§2.5, §3.1). No separate "controller" layer beyond the route handler itself calling straight into the service — a deliberately thin routing tier.

### 21.5 Validation

Zod schemas at the route layer for several modules (letters, org-units, feature-flags, internal roles); elsewhere validation happens inline in the service (e.g. `DocumentStateMachine.validateTransition`, `statusPermissions.service.ts`'s action/status set checks). `envSchema` (Zod) validates every environment variable at process boot, before any other code runs (§22).

### 21.6 Error handling

`AppError` (`core/AppError.ts`) — a typed application error (HTTP status + machine-readable `code` + message) thrown from anywhere in a service, caught by `errorHandler` (`shared/middleware.ts`, the last middleware in `app.ts`) and shaped into a consistent `{error:{code,message}}` JSON body. `asyncHandler` (`shared/asyncHandler.ts`) wraps every route handler so a rejected promise reaches `errorHandler` rather than crashing the process (belt-and-suspenders on top of Express 5's own native async-error propagation).

### 21.7 Authentication / authorization (backend)

Fully covered in §7/§8. Chain per protected request: `authenticate` (JWT verify + Redis revocation check) → `userRateLimiter` (per-user, Redis-backed) → `admissionControl` (§26.7, request-shedding under load) → `tenantContext` (opens the request transaction, sets `SET LOCAL app.current_tenant` for RLS) → `requirePermission`/`requireAnyPermission` → `requireACL` where resource-scoped.

### 21.8 Transactions

§2.6 (`runInTransaction`, `runInSavepoint`, `afterCommit`) is the authoritative section — do not re-derive this from first principles when reading the code; the CLS-transaction gotcha it documents is genuinely non-obvious and was the source of a real defect class (silent non-atomic audit writes) before it was understood and fixed.

### 21.9 Logging

`pino` (structured JSON logs in production, `pino-pretty` in dev), `pino-http` for request logging, `pino-roll` for log rotation. `requestIdMiddleware` stamps a correlation id on every request, threaded through to background-job logs via `getCorrelationId()` (`shared/requestContext.ts`) so a job enqueued from a request can be traced back to it in logs.

### 21.10 Configuration

§22 in full.

### 21.11 Startup / shutdown

§21.1–21.2 above; operational procedures in §24.

### 21.12 Health checks

`GET /health` (root, always-on, minimal), `GET /api/v1/health` (same, under the API prefix), `GET /operations/health` (public, deep — probes db/redis/minio/meilisearch/outbox concurrently with a 2-second timeout each, cached 5 seconds with single-flight collapsing to survive a thundering-herd of dashboard polling — §26.7 detail, this was itself a load-safety fix).

---

## 22. Configuration and Environment

### 22.1 The production isolation contract (identical across GMS/DMS/SSO — platform-wide rule)

`NODE_ENV=production` → **only** `backend/.env.production` is read; `.env` (the dev file) is **never** read. A missing `.env.production` is a hard boot refusal naming the file, not a silent fallback to schema defaults. This is deliberately **not** a layered arrangement (`.env` underneath `.env.production`) — layering looks harmless and isn't, because dotenv only overrides keys the layering file actually *names*; a real 2026-09-05 production launch of DMS silently inherited a personal Gmail address into `EMAIL_REDIRECT_TO`, dev MinIO credentials, and no `STORAGE_LOCAL_PATH` this exact way, and separately, `.env`'s own first line (`NODE_ENV=development`) clobbered the launcher's `NODE_ENV=production` under `override:true`, disabling every boot-time guard simultaneously. `override:true` is still used (so a stray machine-wide env var can't win over the file), but only ever against **the correct single file** for the current mode. `tests/envLoadingContract.test.ts` runs the real loader in a child process to pin this down. Verify without starting anything: `npm run env:verify:prod`.

### 22.2 Complete environment variable reference (from `config/env.ts`'s Zod schema — every variable in the schema, verified)

| Variable | Default | Required in prod? | Sensitivity | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | `development` | — | — | `development`\|`test`\|`staging`\|`production` |
| `AUDIT_HMAC_SECRET` | — | Yes, ≥32 chars, not the example placeholder | **Secret** | HMAC-signs every audit-log entry |
| `AUDIT_CHAIN_SHARDS` | `8` | No | — | Per-tenant audit hash-chain shard count, 1–64 (§26.6) |
| `PORT` | `7100` | — | — | API listen port |
| `RATE_LIMIT_USER_PER_MINUTE` | `100` | — | — | Per-user request budget on the authenticated API |
| `HOST` | `127.0.0.1` | — | — | Loopback-only by policy — the reverse proxy is the sole public entry point |
| `API_BASE_PATH` | `/api/v1` | — | — | API mount prefix |
| `TRUST_PROXY` | `loopback` | — | — | Express `trust proxy` setting — never `true` (§26.1) |
| `PUBLIC_BASE_PATH` | `""` | Set to `/dms` in prod | — | Browser-visible cookie path prefix on the shared platform origin |
| `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` | localhost/5432/postgres/""/edams | Yes (real password, never `postgres` superuser) | **Secret** (password) | Database connection |
| `DB_POOL_MAX`/`MIN`/`ACQUIRE_MS`/`IDLE_MS` | 60/2/30000/10000 | — | — | Connection pool — `DB_POOL_MAX` is the real concurrency ceiling (§26.7) |
| `DB_STATEMENT_TIMEOUT_MS` / `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 30000 / 120000 | — | — | Per-transaction `SET LOCAL` caps, not connection-wide |
| `REQUEST_ADMISSION_MAX` | `0` (→ `DB_POOL_MAX*2`) | — | — | In-flight request ceiling before shedding 503s (§26.7) |
| `DATABASE_URL` | — | Optional | **Secret** | Explicit connection string, ignored unless... |
| `DATABASE_URL_TRUSTED` | `false` | — | — | ...this is also `true` — defeats a stray ambient `DATABASE_URL` |
| `JWT_SECRET`/`JWT_REFRESH_SECRET` | — | Yes, ≥16 chars (≥32 enforced in prod guard) | **Secret** | Token signing |
| `JWT_ACCESS_EXPIRES_IN`/`JWT_REFRESH_EXPIRES_IN` | 15m / 8h | — | — | Token lifetimes |
| `CAMS_VERIFY_BASE_URL` | `http://localhost:7101/verify` | Set to real prod URL | — | Encoded into letter QR codes |
| `DMS_INTERNAL_API_KEY` | unset (routes refuse) | Yes, matching SSO's copy | **Secret** | Internal admin API shared secret |
| `INTERNAL_API_ALLOWED_IPS` | `127.0.0.1,::1,::ffff:127.0.0.1` | — | — | IP allowlist for the internal API |
| `LOCAL_JWT_MOCK` | `false` | Loud warning if true, not refused (2026-07-31 decision) | — | Passwordless dev login |
| `DEV_JWT_ISSUER`/`DEV_JWT_AUDIENCE` | unset | **Must stay unset in prod** (hard refusal) | — | Dev override that previously caused a real mis-issued-token incident |
| `AUTH_ISSUER`/`AUTH_AUDIENCE` | required in prod only | Yes in prod | — | Real SSO issuer/audience |
| `AUTH_JWKS_URI` | — | Yes in prod | — | IdP's published JWKS endpoint |
| `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_REDIRECT_URI` | — | Yes for SSO login | **Secret** (client secret) | OIDC relying-party config |
| `OIDC_SCOPES` | `openid profile email ad_groups edams_roles` | — | — | Must explicitly include `ad_groups edams_roles` (§7.3) |
| `OIDC_TOKEN_ENDPOINT` | falls back to `AUTH_ISSUER+/token` | — | — | — |
| `DEV_RSA_PRIVATE_KEY`/`DEV_RSA_PUBLIC_KEY` | — | Dev/mock only | **Secret** (private key) | Dev-mock JWT signing keypair |
| `SEARCH_ENGINE` | `postgres` | — | — | `postgres`\|`meilisearch` **[CFG]** |
| `REDIS_URL` | — | Yes (hard-required at runtime, not schema-enforced) | — | Redis connection |
| `MINIO_ENDPOINT`/`PORT`/`USE_SSL`/`ACCESS_KEY`/`SECRET_KEY`/`BUCKET_DOCUMENTS`/`BUCKET_ARCHIVE` | localhost/9000/false/""/""/dms-documents/dms-archive | Access/secret key required only when `STORAGE_DRIVER=minio` | **Secret** (keys) | MinIO config |
| `MEILISEARCH_HOST`/`MEILISEARCH_MASTER_KEY` | unset | Required only when `SEARCH_ENGINE=meilisearch` | **Secret** (key) | Meilisearch config |
| `SMTP_HOST`/`PORT`/`SECURE`/`USER`/`PASS` | localhost/1025/false | Real relay required in prod (localhost refused) | **Secret** (pass) | Outbound mail |
| `EMAIL_FROM` | `DMS System <noreply@edams.local>` | — | — | — |
| `EMAIL_REDIRECT_TO` | unset | **Must stay unset in prod** (hard refusal) | — | Dev-only mail-redirect safety valve |
| `CLAMAV_HOST`/`PORT`/`ENABLED` | localhost/3310/false | — | — | Antivirus **[CFG]** |
| `OUTBOX_EMAIL_MAX_AGE_HOURS` | `72` | — | — | EMAIL/WEBHOOK outbox abandon window |
| `ENABLE_QUEUE_WORKERS` | `true` | `false` in the API process in prod (separate worker process) | — | — |
| `ENABLE_OUTBOX_POLLING` | `true` | `false` in the API process in prod | — | — |
| `OUTBOX_POLL_INTERVAL_MS` | `5000` | — | — | — |
| `ENABLE_API_DOCS` | `true` | **Must be `false` in prod/staging** (hard refusal) | — | Swagger UI + disables the deny-everything CSP when true |
| `ENABLE_PUBLIC_METRICS_ROUTE` | `false` | Only when the API port is genuinely not internet-exposed | — | Unauthenticated `/metrics` |
| `STORAGE_DRIVER` | `local` | — | — | `local`\|`minio` **[CFG]** |
| `STORAGE_LOCAL_PATH` | `<cwd>/storage/dms-documents` | Set to an absolute path outside the checkout in prod | — | §14.3 |
| `VAULT_BACKEND` | unset (→`dev` if `DEV_VAULT_MOCK`) | Must be `env`\|`hashicorp` in prod | — | KEK backend selector |
| `VAULT_ADDR`/`VAULT_TOKEN`/`VAULT_NAMESPACE`/`VAULT_TRANSIT_MOUNT`/`VAULT_TRANSIT_KEY_PREFIX` | — | Required when `VAULT_BACKEND=hashicorp` | **Secret** (token) | HashiCorp Vault Transit config |
| `VAULT_MASTER_KEY` (preferred) / `DEV_VAULT_MASTER_KEY` (legacy name, still read) | dev placeholder | Must be ≥32 chars, not the placeholder, in prod | **Secret — the single most critical secret in the system (§25)** | Version-1 KEK |
| `DEV_VAULT_MOCK` | `true` | **Must be `false` in prod** (hard refusal) | — | Dev vault mock flag |
| `DEV_VAULT_MASTER_KEY_CURRENT_VERSION` | `1` | — | — | Which KEK version wraps new DEKs |
| `BUSINESS_HOURS_START`/`END`/`BUSINESS_TIMEZONE` | 9/17/UTC | — | — | SLA business-hours calculation |
| `CLIENT_URL` | `http://localhost:7101` | Set to real prod frontend URL | — | Default CORS origin |
| `CORS_ORIGINS` | falls back to `[CLIENT_URL]` | — | — | Comma-separated CORS allowlist |
| `ESIGN_P12_B64`/`ESIGN_P12_PASSPHRASE` | unset (PAdES step skipped) | Needed for PAdES flattened copies | **Secret** | §17.2 |
| `AI_PROVIDER`, `GROQ_API_KEY`/`MODEL`, `OPENAI_API_KEY`/`MODEL`/`BASE_URL`, `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`, `ANTHROPIC_API_KEY`/`MODEL` | see schema | Only if AI feature used | **Secret** (keys) | Provider-agnostic AI config (§9-adjacent, `modules/ai/llmClient.ts`) |

### 22.3 Conditional configuration (only required when the subsystem is actually selected)

This is a deliberately-designed pattern, not an oversight — `MINIO_ACCESS_KEY`/`SECRET_KEY` only required when `STORAGE_DRIVER=minio`; `MEILISEARCH_MASTER_KEY`/`HOST` only required when `SEARCH_ENGINE=meilisearch`. Marking them unconditionally required was a **real production boot-blocker** once (the Example Corp server runs local storage + Postgres search with neither service installed) — fixed via `.default("")` on the field plus a `superRefine` cross-field check that only fires when the subsystem is actually selected. Any new optional subsystem should follow the identical shape.

### 22.4 Production boot guards (`assertProductionRuntimeRequirements()`, runs only when `NODE_ENV∈{production,staging}`)

Hard-refuses boot (throws, before the server ever listens) on: an untrusted ambient `DATABASE_URL`; empty DB password or `DB_USER=postgres`; missing `AUTH_JWKS_URI`/`AUTH_ISSUER`/`AUTH_AUDIENCE`; JWT secrets <32 chars; `MEILISEARCH_MASTER_KEY` missing when Meilisearch selected; `AUDIT_HMAC_SECRET` still the example placeholder; MinIO secret key still a `minioadmin*` default; `SMTP_HOST` pointing at localhost/127.0.0.1; `EMAIL_REDIRECT_TO` set at all; `DEV_VAULT_MOCK=true`; `DEV_JWT_ISSUER`/`DEV_JWT_AUDIENCE` set at all (a real prior incident — a prod token's `iss` claim read `http://localhost:7300`); `ENABLE_API_DOCS=true`; `VAULT_BACKEND` not `env`/`hashicorp`; the current-version KEK master key missing, still the placeholder, or <32 chars. **Does not** hard-refuse `LOCAL_JWT_MOCK=true` (loud warning only, by the 2026-07-31 decision) and, as a settled cross-system decision rather than a gap to fix, does **not** reject the shared, well-known weak DB password convention.

### 22.5 Verifying resolved production config without starting anything

`cd backend && npm run env:verify:prod` — prints the resolved database name, issuer, and every setting (secrets shown only as character-lengths, never values), runs every boot guard, and binds no port / opens no connection.

---

## 23. Production Deployment

Three documented paths exist. **Only one is what the Example Corp server actually runs** — the others are real, tested, supported alternates for a standalone deployment, not the live system. Do not confuse them.

| Path | Runbook | Used by Example Corp production? |
|---|---|---|
| **Native, no Docker** | `Documentations/DEPLOY-WINDOWS-MANUAL.md` | **Yes — this is the live deployment** |
| Docker Compose (VPS/standalone) | `Documentations/DEPLOY-COMPOSE.md` | No |
| Disaster recovery restore | `Documentations/DR-RUNBOOK.md` | Only during a restore |

### 23.1 The reference live deployment

**Server architecture**: shared Example Corp internal server, one shared Apache reverse proxy fronting GMS/DMS/SSO (MRS retired). DMS lives in its install folder (for example `C:\apps\dms`). Database `dmsprod` on the same shared Postgres instance as `gmsprod`/`idpprod`. Redis is the server's existing shared instance, DMS on a **separate logical DB index** so its keys don't collide with the other apps on DB 0 (`REDIS_URL=redis://127.0.0.1:6379/1`).

**Ports**: backend `7100` (loopback-only, `HOST=127.0.0.1`), frontend `7101` (loopback-only). Apache alone owns 80/443 and does path routing: `/dms → 127.0.0.1:7101`, `/dms/api/v1 → 127.0.0.1:7100/api/v1`, `/dms/socket.io/ → 127.0.0.1:7100` (prefixed — an unprefixed `/socket.io/` on this shared server belongs to GMS).

**Database role setup** (run once, as the Postgres superuser):

```
CREATE DATABASE dmsprod;
CREATE ROLE edams_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<DMS_APP_DB_PASSWORD>';
GRANT CONNECT ON DATABASE dmsprod TO edams_app;
GRANT USAGE ON SCHEMA public TO edams_app;
GRANT CREATE ON SCHEMA public TO edams_app;
GRANT CREATE ON DATABASE dmsprod TO edams_app;
```

**All four grants are required, not just CONNECT/USAGE** — found the hard way on the 2026-07-30 deploy: `USAGE` alone lets `edams_app` read existing objects but `db:migrate` needs to create new tables (`CREATE ON SCHEMA public`), and separately, the baseline migration's `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` needs database-level `CREATE` (`GRANT CREATE ON DATABASE`) — schema-level `CREATE` does not cover extensions. Missing either surfaces as `permission denied for schema public` or `permission denied to create extension "pgcrypto"` on the **first** `db:migrate:prod` run against a freshly-created role, not at role-creation time. If `psql` isn't on `PATH` on the target server (has not been, every time so far), the same SQL runs through Node via the already-dependency `pg` package instead.

**Build / migrate / seed**:

```
Set-Location C:\apps\dms
npm install
npm run build

Set-Location C:\apps\dms\backend
npm run db:migrate:prod        # as edams_app itself now (backend\.env.production must already set DB_USER=edams_app and edams_app must already have all four grants above)
npm run db:seed:reference      # NOT seed-core — that's the demo seed and refuses to run in production entirely
```

**Three console windows, not two** (root-caused 2026-08-28: a native segfault inside a PDF-OCR rasterization library was taking the whole API process down mid-request whenever it hit certain letterhead/scan PDFs — the fix was splitting workers out of the API process entirely, mirroring `docker-compose.prod.yml`'s long-standing backend/worker service split, which this native deploy had drifted from):

```
# Window 1 — API (backend\.env.production sets ENABLE_QUEUE_WORKERS=false)
Set-Location C:\apps\dms\backend
npm run start:prod

# Window 2 — worker
Set-Location C:\apps\dms\backend
npm run worker:prod

# Window 3 — frontend
Set-Location C:\apps\dms\frontend
npm run start
```

`npm run start:prod` is what sets `NODE_ENV=production` **before** the process starts (via `scripts/run-with-env.cjs`) — running `node dist/src/main.js` directly boots in development mode against the development database with every production boot guard skipped, silently.

**SSO integration wiring** (`backend\.env.production`, matched against SSO's own config):

| DMS variable | Must equal |
|---|---|
| `AUTH_ISSUER`/`AUTH_JWKS_URI`/`AUTH_AUDIENCE` | SSO's real issuer/JWKS/audience — a mismatch here presents as an immediate 401 after an otherwise-successful login (this exercises the exact `iss`/`aud` fix in `auth.routes.ts`) |
| `OIDC_CLIENT_SECRET` | SSO's `EDAMS_CLIENT_SECRET` for client id `edams` |
| `DMS_INTERNAL_API_KEY` | SSO's own `DMS_INTERNAL_API_KEY` (§6.10) — **not** the root `.env.prod`, which is the unused Docker Compose file; comparing against the wrong file is a repeat mix-up the deploy checklist calls out by name |

SSO's own `.env.production` points at DMS with `DMS_OIDC_AUTHORIZE_URL=https://portal.examplecorp.com/dms/api/v1/auth/oidc/authorize`, `DMS_BACKCHANNEL_LOGOUT_URI=https://portal.examplecorp.com/dms/api/v1/auth/backchannel-logout`, `DMS_API_BASE_URL=http://127.0.0.1:7100/api/v1` (direct server-to-server, bypassing Apache entirely for this internal call).

**Frontend build-time config** (`frontend\.env.production`, baked at build): `NEXT_PUBLIC_API_BASE_URL=https://portal.examplecorp.com/dms/api/v1`, `NEXT_PUBLIC_SOCKET_URL=https://portal.examplecorp.com`, `NEXT_PUBLIC_BASE_PATH=/dms`. `frontend\.env.local` must not exist on this machine — checked explicitly by the platform deploy checklist (item C19).

**Verification (the platform deploy checklist's DMS-specific rows)**:

| Check | Expected |
|---|---|
| `dmsprod` exists on the shared Postgres instance | `psql -l` lists it |
| `npm run env:verify:prod` (from `backend`) | `DB_NAME dmsprod`, `EMAIL_REDIRECT_TO (unset, correct)`, `All production guards passed.` |
| DMS backend startup log | `[vault] KEK self-test passed` — a failure here means the configured `VAULT_MASTER_KEY` cannot decrypt what is already stored; **stop and let nobody upload** |
| DMS backend startup log | `StorageAdapter: using local filesystem` with base `<storage-folder>/dms-documents` — if the base is under `backend\`, `STORAGE_LOCAL_PATH` is not being read and the corpus is landing inside the git checkout |
| `Invoke-WebRequest https://portal.examplecorp.com/dms/api/v1/health` | 200 |
| Sign in via SSO portal, both tiles (EDAMS/DMS + GMS) | Each returns to that app's dashboard, not a 404 |
| Log in via SSO, refresh the page, wait for a token refresh | No 401 — exercises the `iss`/`aud` matching above |

### 23.2 Docker Compose path (supported alternate, not the live system)

`docker-compose.prod.yml` at the repo root: Caddy (TLS, only published ports 80/443) → frontend + backend, plus a separate `worker` service, Postgres 16, Redis 7, MinIO (versioned buckets), Meilisearch, ClamAV, Prometheus/Grafana, a `migrate` one-shot (runs as the Postgres superuser before anything else starts), and a nightly `db-backup` sidecar. Secrets live only in a server-side `.env.prod` (gitignored; `.env.prod.example` is the authoritative template). First launch: `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build`, then bootstrap the first tenant with `seed-core.js` on an **empty** prod DB only. Full procedure in `Documentations/DEPLOY-COMPOSE.md`.

### 23.3 Rollback / recovery

No down-migration path is treated as reliable for a live system (`Documentations/rollout.md` §1 — the down-migration code exists but rollback safety in practice comes from **expand/contract** migration discipline, not from actually running a migration backward). Application-code rollback is a plain redeploy of the previous build (`git checkout` to the prior tag/commit, rebuild, restart) — safe **only** if the intervening migrations were expand-only (backward-compatible with the old code). Full disaster-recovery restore procedure is §25.

---

## 24. Operations Runbook

### 24.1 Starting DMS (native, production)

Three console windows in order: **1)** API (`cd backend && npm run start:prod`), **2)** worker (`cd backend && npm run worker:prod`), **3)** frontend (`cd frontend && npm run start`). Verify with `Invoke-WebRequest https://portal.examplecorp.com/dms/api/v1/health`.

### 24.2 Stopping DMS

Close each console window (or send `Ctrl+C`/`SIGTERM` if wrapped in a scheduled task/NSSM) — the graceful-shutdown handler in each process (§21.1–21.2) drains in-flight requests/jobs before exiting, bounded by a 10-second forced-exit timeout.

### 24.3 Restarting DMS

Stop, then start, in the same order. A code deploy additionally requires: `git pull` → `npm install` (root) → `npm run build` → `cd backend && npm run db:migrate:prod` → restart all three windows. `.env.production` is never touched by `git pull` (gitignored) — but check `backend\.env.example` for keys added since the last deploy, since nothing is inherited by accident under the isolated-env-file contract (§22.1).

### 24.4 Checking health

`GET /operations/health` (public, cached 5s, single-flight) → `{db, redis, minio, meilisearch, outbox, outboxPending, sampledAgoMs}`. `curl -fsS https://portal.examplecorp.com/dms/api/v1/health` for the shallow liveness check; an operator-token `GET /api/v1/operations/health`... *(the deep endpoint is actually `/operations/health`, public — no operator token needed; the metrics/pipeline endpoints are the ones needing `operations:read`/`manage`)*.

### 24.5 Checking logs

Pino structured JSON in production (each request/job carries a correlation id from `requestIdMiddleware`/`getCorrelationId()`); `pino-pretty` only in dev. No centralized log aggregation identified in this session's review beyond `pino-roll`'s local rotation — treat as **[GAP]** for cross-process (API+worker) log correlation beyond the shared correlation id convention.

### 24.6 Checking workers

`GET /operations/pipeline-metrics` (OCR/AI job outcome counts + average durations) and `GET /operations/outbox` (non-terminal outbox rows — a growing backlog here with no corresponding worker activity is the first sign a worker process is down or stuck).

### 24.7 Checking the database

`npm run db:migrate:status` (pending migrations), `npm run env:verify:prod` (resolved connection target), direct `psql` against `dmsprod` for anything deeper (`pg_stat_activity` for connection-pool pressure — cross-reference against `DB_POOL_MAX=60`).

### 24.8 Checking storage

Confirm the backend startup log's `StorageAdapter: using local filesystem` line names the correct base path (§23.1); `df`/`Get-PSDrive` for free disk space on that volume specifically (not the system drive, if `STORAGE_LOCAL_PATH` was pointed at a second disk per §14.10).

### 24.9 Checking queues

`GET /operations/outbox` for outbox-channel backlog; BullMQ's own Redis-backed queue state is not exposed through a DMS admin panel — inspecting it directly requires Redis tooling (e.g. `redis-cli` against the queue's keys) or a general BullMQ dashboard, neither of which is wired into this codebase's admin UI. **[GAP]**

### 24.10 Checking OCR / PDF generation / e-signing / notifications / SSO

- **OCR**: `GET /operations/pipeline-metrics`'s `ocr` block; a document stuck at `ocrStatus:pending` with no corresponding metric movement means the worker isn't processing OCR jobs.
- **PDF generation**: no dedicated health probe — a failure surfaces as a 500 on the specific letter/form/e-sign-completion request; check application logs for the request's correlation id.
- **E-signing**: `GET /signing/requests?scope=pending-me` etc. for queue state; `GET /operations/outbox` for a stuck `EMAIL`-channel invite that never went out.
- **Notifications**: `GET /operations/outbox` for `WEBSOCKET`/`EMAIL` channel backlog.
- **SSO**: `npm run env:verify:prod`'s issuer/audience printout; the JWKS cache can be force-refreshed via `POST /auth/oidc/jwks/refresh` (SYSTEM_ADMIN) after a known IdP key rotation.

### 24.11 Diagnosing failures / recovery / rollback

See §29 (Troubleshooting) for a symptom-indexed encyclopedia; §23.3 for rollback; §25 for full disaster recovery.

---

## 25. Backup and Disaster Recovery

Full authoritative source: `Documentations/DR-RUNBOOK.md` (Docker-path procedure; the native deployment's restore procedure is the **same shape**, just via `scripts/db-backup.ts`/`pg_restore` directly rather than through compose).

### 25.1 What must survive a dead server

The Postgres database (documents metadata, letters, audit chain, wrapped DEKs), the document blob store (encrypted blobs — MinIO or local disk), and **the KEK master keys** (`VAULT_MASTER_KEY[_V{n}]`, escrowed separately). Losing the DB or the blobs loses records; **losing the master keys loses everything** — every wrapped DEK becomes permanently unwrappable, which is cryptographically indistinguishable from having deleted every document. Meilisearch and Redis are rebuildable state (reindex / queues drain) and are explicitly **not** part of the DR scope.

### 25.2 What the Docker Compose stack already automates

| Concern | Mechanism |
|---|---|
| Nightly DB dumps | `db-backup` sidecar, `pg_dump --format=custom` at 02:00 UTC, `BACKUP_RETENTION_DAYS` (default 14) pruning |
| Blob overwrite/delete protection | Object versioning enabled on `dms-documents`/`dms-archive` (`deploy/backup/minio-init.sh`, idempotent one-shot) |
| Secrets | `.env.prod` on the server only, never in git |

### 25.3 What must be added per environment (not automatable from the repo)

1. **Off-server copy of DB dumps** — nightly rclone sync (or equivalent) to any off-box backend (Backblaze B2, S3, a second server over SFTP), 48h max-age guard.
2. **Off-server copy of blobs** — `mc mirror --watch` from a second machine, or a scheduled `mc mirror --overwrite` job.
3. **Escrow the KEK master keys** — print/store `VAULT_MASTER_KEY` (and every `VAULT_MASTER_KEY_V{n}`), `AUDIT_HMAC_SECRET`, and the RSA keypair in a password manager / sealed envelope **physically separate from the server**. For `VAULT_BACKEND=hashicorp`: escrow the Vault unseal keys + a periodic Vault storage snapshot instead.

### 25.4 Restore procedure (Docker path; native path is the same order with different commands)

1. Bring up **only** the datastores (`postgres`, `minio`) — not `migrate`/`api` yet, since the DB must be restored before migrations stamp a fresh `SequelizeMeta`.
2. `pg_restore -U postgres -d dms --clean --if-exists --no-owner` the newest dump.
3. Restore blobs into the MinIO volume from the offsite copy, then re-run the `minio-init` versioning one-shot.
4. Bring up the full stack — `migrate` is a no-op if the restored `SequelizeMeta` is current, otherwise it applies only the missing migrations forward.
5. Rebuild derived state: Meilisearch reindexes lazily via the `SEARCH_INDEX` outbox (or trigger a full reindex manually); Redis has nothing to restore (queues repopulate, BullMQ repeatables re-register at worker boot).

### 25.5 Verification after any restore (do not skip)

```
curl -fsS https://<API_DOMAIN>/api/v1/operations/health   # with an operator token: db/redis/minio/meili all ok
cd backend && npx tsx test-scripts/verify-audit-atomicity.ts  # audit hash chain still valid
```
Plus a manual end-to-end: download one known document **and** one letter PDF (proves DEK unwrap with the escrowed master keys against the restored blobs).

### 25.6 The restore drill (acceptance test for this whole runbook)

Rehearse once before go-live and after any major storage change, on a scratch machine or scratch compose project. A restore-drill script (platform tooling, not part of this repository) automates the **database half**: creates a disposable scratch database (refuses any name containing "prod" as a safety backstop), restores a given dump into it, spot-checks row counts on key tables, then drops the scratch database. It does **not** cover the MinIO blob restore or DEK-unwrap verification — those must be run manually against a scratch compose stack, at minimum quarterly, in addition to the script. A dated log table exists in the runbook for recording each drill's outcome — as of this session, it shows **"pending first drill"** (no drill has yet been recorded). **[GAP — operationally important, explicitly tracked as not-yet-done rather than silently absent]**

### 25.7 Recovery order (summary)

Datastores first (Postgres + object store) → data restored → application layer (migrate → API/worker) → derived state rebuilt (search index) last, since it is the only layer that is genuinely disposable and regenerable.

### 25.8 RPO / RTO

Not formally specified as numeric targets anywhere in the reviewed documentation — the operative commitments are the nightly dump cadence (≤24h RPO for DB, contingent on the off-server copy actually running) and `BACKUP_RETENTION_DAYS=14`. Raise `BACKUP_RETENTION_DAYS` if 14 days of history does not satisfy a specific archival-compliance requirement. **[GAP — no numeric RTO commitment found; the restore procedure's actual wall-clock time has not been measured via a recorded drill yet]**

### 25.9 Failure modes covered / not covered

- **Covered**: dead disk/server, ransomware on the host (offsite copies + MinIO versioning), fat-fingered delete (versioning + dumps), a bad deploy (dumps predate it; migrations are expand/contract per `Documentations/rollout.md`).
- **Not covered**: a compromised `.env.prod`/`.env.production` (the prescribed response is rotating every secret and rewrapping every DEK via `scripts/rewrap-deks.ts` after bumping the master-key version — a real operational procedure, not automatic); silent data corruption older than the retention window (raise `BACKUP_RETENTION_DAYS` if this is a real risk for the archival-compliance requirement in force).

---

## 26. Security

### 26.1 Authentication / sessions / tokens

Covered fully in §7. Key protections: fail-closed revocation in production (Redis-down → 503, never silent accept); force-close-logout via `user_session_cutoffs`; `TRUST_PROXY=loopback` (never `true`) so `req.ip` cannot be forged by a client-supplied `X-Forwarded-For` header — this single setting is what protects three independent things at once: the per-IP rate limiters (collapsed to one bucket for the whole company without it — a real, previously-live footgun), `audit_logs.source_ip` (the forensic record of who acted from where), and the `AUTHN_FAILURE` audit sampler's per-IP bucketing (used to detect credential-stuffing bursts).

### 26.2 ACL resolution (`resolveACL.ts`) — the resource-authorization engine

DENY-first, ancestor-walking, five steps: (1) check direct `acl_entries` on the resource itself; (2) walk folder ancestors via a recursive CTE up `folder_nodes.parent_id`; (3) walk department ancestors via a recursive CTE up `departments.parent_id`; (4) check `access_rules` for tenant-wide or document-type-scoped grants; (5) deny by default if nothing matched an ALLOW. Cached in an in-memory LRU+TTL (`aclCache`), invalidated on ACL changes via a Redis `SCAN+UNLINK` broadcast (multi-instance-safe). The LRU's `set()` correctly moves an existing key to the most-recently-used end before re-inserting — a real, previously-broken behavior that would otherwise retain stale entries under eviction pressure.

**A documented gap, closed**: legal-hold routes used to be gated by `requireACL({resourceType:'legal_hold',...})` even though **nothing anywhere in the codebase ever writes an `AclEntry` row for that resource type** (unlike documents/folders, which get one automatically via `grantDefaultDocumentAcl`) — so every legal-hold request 403'd for every role except `SYSTEM_ADMIN`, including `RECORDS_OFFICER`/`DEPT_MANAGER`, both explicitly granted `legalhold:manage` and clearly meant to use the feature. Fixed by recognizing that a legal hold isn't a per-instance-ACL'd resource the way a document/folder is — it's a plain tenant-wide RBAC capability — so the fix was RBAC (`requirePermission`, already present) + tenant scoping in the service, not inventing a per-resource ACL grant that nothing would ever populate.

### 26.3 CSRF / XSS / injection

- **CSRF**: the OIDC `state`/`nonce` mechanism (§7.3) is the CSRF guard on the login flow specifically; the API otherwise relies on the fact that it is a pure JSON API with Bearer-token auth (no ambient-cookie-authenticated state-changing GET, no implicit browser form-post auth) — the classic CSRF vector (a browser automatically attaching a session cookie to a cross-site request) does not apply to Bearer-token-in-header auth the way it does to cookie sessions. The **refresh** token *is* a cookie, but it's HttpOnly + `SameSite` and only ever read by `POST /auth/refresh`, which itself does not perform a state-changing domain action beyond issuing a new token.
- **XSS**: this is a JSON API — a deny-everything CSP (`helmet`, `contentSecurityPolicy`) is applied to every response when `ENABLE_API_DOCS=false` (always the case in production), which is safe precisely because there is no server-rendered HTML surface to protect beyond that. Frontend XSS protection is React's default JSX-escaping behavior plus Next.js's own defaults — no `dangerouslySetInnerHTML` usage was flagged in this session's review of the reviewed files.
- **SQL injection**: Sequelize's parameterized query builder is the default path everywhere; the internal-roles module's raw `sequelize.query()` calls (§6.10) use `replacements`/`bind` parameter binding, never string interpolation into SQL.
- **Helmet's Cross-Origin-Resource-Policy fix**: helmet's default `same-origin` CORP is enforced by the *browser* independently of CORS — it silently blocked every cross-origin `fetch()`/XHR from ever reading the response body even with fully correct CORS headers, since this API is always consumed cross-origin (a separate frontend origin). Fixed by explicitly setting `crossOriginResourcePolicy: {policy: 'cross-origin'}` — invisible to server-side curl-based testing (curl doesn't enforce CORP), which is exactly why it went unnoticed until real browser fetches (document download/preview, the signing field placer) started failing with a bare "Failed to fetch."

### 26.4 API security / rate limiting

Three tiers: `/api/v1/auth` (20/min per IP — brute-force/credential-stuffing protection), `/api/v1/documents/upload` (10/min per IP — one uploader can't starve others), `/api` (800/min per IP — generous, since per-user limiting is the real cap on protected routes). The protected-route per-user limiter (`RATE_LIMIT_USER_PER_MINUTE`, default 100/min) sits **after** `authenticate` (so `req.user.userId` is available to key on) and **before** `admissionControl`/`tenantContext` — deliberately, so a single abusive authenticated caller is capped by its own budget before it can consume the shared DB-connection concurrency allowance the admission-control layer protects (§26.7). Redis-backed rate-limit store (`createRedisRateLimitStore`) so limits are consistent across a future multi-instance deployment.

### 26.5 Encryption

Every stored file version is encrypted with its own per-**version** DEK (AES-256-GCM), wrapped (AES Key Wrap / RFC 3394) under a KEK managed by `VaultService`/`HashiCorpVaultService` and stored in `document_deks` (one row per `versionId`). KEKs are numbered versions (`kekId` embeds the version it was wrapped under), so historical DEKs stay decryptable after the current version is raised — rotation (`scripts/rewrap-deks.ts`) is a manually-run, dry-run-by-default, batched/idempotent/resumable script, **not** an automatic background job. `GET /operations/crypto-status` gives read-only rotation visibility (per-version DEK counts, how many sit behind current) where previously this required querying `document_deks` by hand. Production HashiCorp Vault support is an intentional stub in the sense that `getVaultService()` throws outside `DEV_VAULT_MOCK` if not properly configured — no live Vault server was available in this environment to validate the `hashicorp` backend against a real Vault instance beyond the client implementation itself; the `env` backend (same wrapping scheme, master keys injected via secrets) is the one actually exercised in the real Example Corp production deployment.

### 26.6 Audit logging

`audit_logs` — immutable, hash-chained (each row's hash covers the previous row's hash within its shard), HMAC-signed (`AUDIT_HMAC_SECRET`) so a chain tampering attempt is cryptographically detectable, not just logically inconsistent. **Sharded per tenant** (`AUDIT_CHAIN_SHARDS`, default 8) specifically for write concurrency: `writeAuditLog` holds a per-`(tenant, shard)` advisory transaction lock from first write until the request's transaction commits (response-finish time), and with only one shard every mutating request in a tenant would queue behind the one in front of it — the lock exists because the chain tip must be read from committed state under it, or a writer could read a stale tip and durably commit a row that skips the real last entry. Sharding is safe to change at any time (shards are assigned randomly per write, not derived from row content — existing rows keep whatever shard they're in). `AuditChainWorker` verifies full chain integrity daily at 04:00, raising an `AUDIT_INTEGRITY_FAILURE` notification on any break. **Every `writeAuditLog` call is awaited, never fire-and-forget** — a failed audit write propagates and fails the operation it was recording, rather than silently succeeding with no audit trail (`tests/auditAtomicity.test.ts` pins this down).

### 26.7 Load-safety / admission control (R-01, a real production-hardening pass)

`DB_POOL_MAX` (60) is the genuine ceiling on concurrent authenticated requests, because `tenantContext` holds one pooled connection for a request's **entire** lifetime (needed for RLS's per-transaction `SET LOCAL app.current_tenant` to apply at all — a bare query outside a transaction cannot carry it). A documented **correction** to an earlier audit-register recommendation: PgBouncer transaction pooling would **not** raise this ceiling, because DMS's transaction spans the whole request rather than a single statement — under transaction pooling a server connection is still held for the whole request, degenerating to session-pooling behavior for hold-time purposes. What PgBouncer *would* buy (offered as an opt-in compose profile, not deployed on the live server) is decoupling client from server connections so the API process, the worker, and a future second instance share one server-connection budget instead of each reserving `DB_POOL_MAX` independently.

**`admissionControl`** middleware sheds excess requests with an immediate `503` + `Retry-After` once `REQUEST_ADMISSION_MAX` in-flight authenticated requests are already holding or queued for a connection — deliberately placed *after* the per-user rate limiter (so a single caller is capped by its own budget first) and *before* `tenantContext` (which is what actually checks out the pooled connection — shedding after that point would mean the request had already joined the pool queue, exactly what admission control exists to prevent). Rationale: without a bound, overload does the worst possible thing — every request past `DB_POOL_MAX` queues inside the pool for up to `DB_POOL_ACQUIRE_MS` (30s), holding a socket and its whole parsed request the entire time, converting a burst into thousands of requests all waiting half a minute to be told no while memory climbs and impatient clients retry, compounding the problem. Serving 200s at capacity and 503s past it is strictly better than serving slow timeouts to everyone.

`GET /operations/health` itself was a real instance of exactly this failure mode before its own fix: it ran five real dependency probes (DB, Redis, MinIO, Meilisearch, an outbox COUNT) **serially** with **no timeout** on the Meilisearch call, on a route the dashboard polls every 30 seconds for **every signed-in user** — so its request rate scaled linearly with concurrent logins, a hung (not merely refused) Meilisearch could park a connection indefinitely on a deliberately-public route, and total latency was the *sum* of five dependencies rather than the slowest one. Fixed by decoupling the probe rate from the request rate: a 5-second cached snapshot, single-flight-collapsed so a cold-cache burst of a thousand requests costs exactly one probe set, each probe independently timeout-bounded (2s) and run concurrently rather than serially, with the response honestly reporting how stale the cached sample is (`sampledAgoMs`) rather than implying it's live.

### 26.8 Dependency security

CI runs `npm audit --omit=dev --audit-level=high` via `tools/audit-gate.mjs` — a written-exception gate (one advisory currently accepted with a documented reason and removal condition), not a bare pass/fail, because a permanently-red gate gets ignored. `npm audit fix --force` is never run (§4.4) — it would downgrade `sequelize`/`exceljs`/`minio` to broken major versions. Trivy scans the backend Docker image in CI, failing only on fixable CRITICALs (Docker-path CI job; native deployment has no image to scan).

### 26.9 Secrets / server security

Every real secret lives only in gitignored env files (`.env.production`, `.env.prod`), never committed. `backend/storage/` (runtime uploads) is gitignored. `TRUST_PROXY`, CORS allowlist, CSP, and the internal-API IP allowlist are the network-boundary controls; loopback-only `HOST` binding on both backend ports means the Apache proxy is the sole network path to either process — verified as a deploy-checklist item on the live server (`C5`).

### 26.10 Remaining considerations (honestly stated, not disguised)

- Single-instance deployment — the multi-instance-readiness primitives (Redis rate-limit store, Socket.IO Redis adapter, role/ACL caches, configurable pool, graceful drain, TZ pinning, orphaned-storage sweeper) exist but are unexercised at real scale. **[GAP]**
- No numeric RPO/RTO commitment, and the restore drill has not yet been recorded as run (§25.6/25.8). **[GAP]**
- PostgreSQL ILIKE search has no dedicated text-search index (§13.7) — acceptable at current scale.
- The HashiCorp Vault backend has not been validated against a live Vault server in this environment (§26.5).

---

## 27. Testing

### 27.1 Unit + integration (Jest, backend)

`npm test` from the repo root (`npm --workspace backend test` under the hood) — **52 suites / 478 tests, all passing** as of the last recorded run (`Documentations/TEST_STATUS.md`, generated automatically by `npm run test:status` from the real Jest JSON output, and CI verifies this file matches the actual run via `git diff --exit-code`, so it cannot silently go stale). Representative suite coverage (52 files in `backend/tests/`): the document state machine, ACL resolution + ancestry + batch equivalence, the approvals engine, audit atomicity + chain concurrency + event catalogue + export-query correctness, BRD scenario coverage, bundle addition, ClamAV integration, document-crypto streaming, document validation, envLoadingContract (the real dotenv loader, run in a child process), e-sign PAdES, folder transactions, forms approval-chain/approver/computed-hidden-fields, letter PDF rendering, letters (by-document lookup, reassign/cancel, scope-where), load-safety, lock-service force-unlock/status, org-units, outbox webhook-fanout-idempotency + websocket-recipient-routing, permission enforcement + 403 matrices, production boot guards, rate-limit fallback/store, remediation hardening, request-context source-IP, session revocation, socket handshake, storage-adapter parity, trash-service certificate issuance, trust-proxy behavior, VaultService.

### 27.2 Frontend unit tests

`npm --workspace frontend run test` (Vitest + Testing Library + jsdom).

### 27.3 E2E (Playwright)

`npm run e2e` (from the repo root, against **running** dev servers — not a self-contained harness that boots its own servers). 5 spec files: `documents.spec.ts`, `esigning.spec.ts`, `forms.spec.ts`, `letters.spec.ts`, `smoke.spec.ts`. Fixtures: `e2e/fixtures/api.ts`, `e2e/fixtures/app.ts`. Auth state persisted at `e2e/.auth/admin.json` (a Playwright storage-state file — logged-in session snapshot reused across specs rather than logging in fresh every test). `npm run e2e:ui` / `e2e:report` for interactive debugging / HTML report viewing.

### 27.4 Live-HTTP / live-DB verifiers (`backend/test-scripts/`)

Distinct from both Jest and Playwright — these run against a genuinely running backend + real database, proving behavior unit tests structurally cannot reach (real HTTP round-trips, real timing, real external-service degradation). ~30 scripts, headlined by `verify-cams.ts` (37 checks as of the last recorded count — Amharic letter with embedded-font assertion, scanned-origin letter + cover sheet, attachment add/byte-identical-download/remove with backing-document purge proof) and `verify-audit-atomicity.ts` (8 checks — proves awaited audit writes commit atomically with their domain change and the chain stays valid). Others: `verify-runtime-flows.ts` (38 checks across seven flows unit tests can't reach — MFA pending-token single-use, MFA attempt-lockout, restore-over-quota 413, trash-voids-e-sign-link, deactivation offboarding sweep, the AI consent gate, an `ApprovalSlaWorker` breach reaching PROCESSED via SMTP), `verify-rls-tus-webhook.ts` (tus end-to-end under the `edams_app` rehearsal role, tenant-scoped webhook dispatch, a GUC-less negative control), `test-acl-ancestry.ts`/`test-acl-batch-equivalence.ts` (DB-direct), `verify-phase1-permissions.ts`/`verify-phase2-tenancy.ts`/`verify-phase3-hierarchy.ts` (speak the two-phase auth contract despite the legacy "phase1-3" naming). `npm run verify:all` runs the whole suite; start with `backend/test-scripts/README.md`.

### 27.5 Manual test coverage

A 26-sheet, **252-case manual test checklist** (not included in this edition) — covering setup, auth, the full permission matrix, ACL, multi-tenancy, lifecycle, versioning, search, workflow/SLA, retention, signing, forms, OCR/AI, audit, realtime, webhooks, rate limiting, reports, and bulk operations. This is the manual retest checklist for anything the automated suites don't (or structurally can't) cover.

### 27.6 CI (`​.github/workflows/ci.yml`)

Two jobs: **`typecheck-test-build`** (typecheck both workspaces, lint both, `audit:gate`, `npm test`, `test:status` + a `git diff --exit-code` guard on `TEST_STATUS.md` so it can't silently drift from reality, `npm run build` with placeholder `NEXT_PUBLIC_*` values proving buildability without real secrets) and **`db-backed-integration`** (real Postgres 16 + Redis 7 service containers, `db:migrate:check` + `db:migrate` + `db:seed:core`, `test-acl-ancestry.ts`, then boots the real backend and polls `/health` before running further live checks against it).

### 27.7 Known environmental limitations

- E2E requires already-running dev servers — not fully self-contained.
- The HashiCorp Vault backend's automated coverage is unit-level (`VaultService.test.ts`) rather than against a live Vault instance.
- No load-testing harness identified in this session's review — the `loadSafety.test.ts` suite tests the admission-control/rate-limit *logic*, not real concurrent-load behavior against a live database.

### 27.8 Regression strategy

The combination of (a) a CI gate that fails the build if `TEST_STATUS.md` doesn't match the real Jest run, (b) `audit-gate.mjs`'s written-exception dependency-vulnerability gate, and (c) live-HTTP verifiers proving behavior the unit suite can't reach, is the operative regression-prevention strategy — there is no separate manual regression-sign-off process beyond the manual checklist (not included in this edition) for pre-release verification.

---

## 28. Performance and Scalability

### 28.1 Measured facts vs. recommendations (kept distinct, per the codebase's own convention)

| Measured fact | Source |
|---|---|
| `DB_POOL_MAX=60` is the real concurrency ceiling, because `tenantContext` holds a connection for the full request lifetime | `config/env.ts` comment, verified against live `pg_stat_activity` |
| Shared Postgres instance's `max_connections=100` across GMS/DMS/SSO | Verified against live `pg_stat_activity` per the same comment |
| `GET /operations/health` previously scaled its dependency-probe rate linearly with concurrent logins (30s dashboard poll × every signed-in user) | Fixed; the fix's own commit comment documents the before-state as measured, not hypothetical |
| CAMS legal-hold history query was a full sequential scan of `audit_logs` filtered only by a `LIKE` on `action_details`, on the largest/highest-write table in the system | audit 2026-09-03 R-05, fixed by constraining on `event_type` first |
| Word-count diff endpoint's LCS algorithm is O(m·n) time **and** memory with no cap before the fix | Fixed with a 5000-word/version ceiling |

### 28.2 Bottlenecks (identified and addressed)

- **Request-transaction hold time** is the structural lever on throughput, not just pool size — `requests/sec ≈ DB_POOL_MAX / average request duration`. The request transaction is held across genuinely slow non-DB I/O today (ClamAV scans, PDF rendering, MinIO round-trips inside `letters.service.ts`'s `scanBuffer`/`generateLetterPdf`/`encryptAndStore`), and moving that work into an *inner* `runInTransaction` block does **not** help — the *outer* request transaction still holds the connection regardless. The stated structural fix is to stop the request transaction from spanning that work at all — a design change, explicitly called out as not yet done. **[GAP]**
- **Audit-log write concurrency** — solved via per-tenant sharding (§26.6), not by removing the correctness-critical advisory lock.
- **`aclCache`'s LRU eviction correctness** — fixed (§26.2).
- **CAMS legal-hold chain-of-custody query** — fixed by predicate reordering, deliberately **not** by adding a GIN/trigram index on `audit_logs.action_details`, since that index would be maintained on *every* audit insert (already the system-wide write bottleneck, serialized behind the per-tenant advisory lock) purely to speed up a low-traffic admin view — judged the wrong trade.

### 28.3 Database performance

RLS enforcement adds a `SET LOCAL` per request but is not itself identified as a measured bottleneck; the connection-hold-time issue above is the dominant, measured concern. Indexes exist on the hot columns actually queried (`documents`: department_id, document_type_id, status, owner_id, deleted_at, updated_at, composite department+status, title) — a deliberate, curated set rather than indexing everything.

### 28.4 Search / storage / workers / queues

Search: §13.7 (no dedicated text index on the Postgres fallback path — acceptable at current scale). Storage: local-disk means no independent scaling of storage I/O from application I/O (both share the same physical disk on the production server). Workers/queues: BullMQ + Redis scale horizontally by adding worker processes pointed at the same Redis — not currently done (single worker process in production), but nothing in the architecture prevents it.

### 28.5 Frontend performance

`npm run perf` build/serve target exists for profiling; no further measured frontend performance data was found in this session's review.

### 28.6 Caching

In-memory LRU+TTL for ACL/role/status-permission resolution (invalidated via Redis pub/sub for multi-instance correctness); per-route `Cache-Control` headers tuned by data volatility (`app.ts`'s `cacheControl` middleware — `no-store` for audit, 60s for `/auth/me`, 300s for reference data like document-types/departments/roles, 120s for retention policies/saved searches, 10s for documents/workflow/notifications, 30s for users); `/operations/health`'s 5-second single-flight snapshot cache (§26.7).

### 28.7 Concurrency / scaling limitations

Single-instance deployment today (§1.7, §26.10); the multi-instance-readiness primitives are real but unexercised. Horizontal scaling of the API/worker tier would need: PgBouncer (or equivalent) to share the DB-connection budget across instances (not a throughput fix by itself — see §28.2's correction of the earlier assumption), the already-present Socket.IO Redis adapter for realtime fan-out across instances, and the already-present Redis-backed rate-limit store.

### 28.8 Future scaling paths (recommendations, explicitly labeled as such)

- Stop the request transaction from spanning slow non-DB I/O (§28.2) — the single highest-leverage structural fix identified in the codebase's own commentary.
- A dedicated full-text index (GIN/pg_trgm) on the Postgres search fallback, if Meilisearch is never actually deployed and corpus size grows meaningfully.
- Multi-instance deployment, once real load justifies it — the primitives already exist; this would be an operational/infrastructure change, not a code change.

---

## 29. Troubleshooting

Symptom-indexed. Each entry: symptom → likely cause → check → fix → verify.

| Symptom | Likely cause | Check | Fix | Verify |
|---|---|---|---|---|
| Backend won't start, error names `.env.production` | `NODE_ENV=production` but the file is missing/misplaced | Confirm the launcher actually set `NODE_ENV` **before** the process started | Place `.env.production` at `backend/.env.production`; never let `.env` supply it | `npm run env:verify:prod` |
| `env:verify:prod` prints a dev database name (`DMS`/`gmsdev`/`idp`) | Wrong env file being read, or `NODE_ENV` set after process start | Re-check the exact launch command — `node dist/src/main.js` directly always boots dev mode | Use `npm run start:prod` (sets `NODE_ENV` first via `run-with-env.cjs`) | Re-run `env:verify:prod` |
| Connection error naming an unfamiliar host (e.g. `caboose.proxy.rlwy.net`) | A leftover machine-wide `DATABASE_URL` env var winning over the app's own config | `Get-ChildItem Env:DATABASE_URL` | Unset it, or explicitly set `DATABASE_URL_TRUSTED=true` if it's genuinely intended | Restart, recheck the resolved connection target |
| `permission denied for schema public` / `permission denied to create extension "pgcrypto"` on first `db:migrate:prod` | `edams_app` role missing `CREATE ON SCHEMA public` or `CREATE ON DATABASE` | Re-run the four-grant role-creation SQL from §23.1 | Grant all four, not just CONNECT/USAGE | Re-run `db:migrate:prod` |
| Every authenticated request returns `503 ERR-AUTH-REVOCATION-UNAVAILABLE` | Redis is down or unreachable | `redis-cli ping` against the configured `REDIS_URL` | Restore Redis; this is fail-closed **by design** in production, not a bug | `/operations/health`'s `redis` field returns `ok` |
| SSO login succeeds, then an immediate 401 on the very next request | `AUTH_ISSUER`/`AUTH_AUDIENCE` mismatch between DMS and what SSO actually issues, or `DEV_JWT_ISSUER`/`AUDIENCE` accidentally set | `npm run env:verify:prod`'s issuer printout; confirm `DEV_JWT_ISSUER` is unset in prod | Match DMS's `AUTH_ISSUER`/`AUTH_AUDIENCE` to SSO's real values; unset any `DEV_JWT_*` override | Log in again, refresh the page |
| First-time SSO users all land as `EMPLOYEE` regardless of their AD group | `OIDC_SCOPES` doesn't request `ad_groups edams_roles` | Inspect the id_token claims received at callback | Set `OIDC_SCOPES=openid profile email ad_groups edams_roles` | New SSO user gets the mapped role |
| `/internal/roles/*` calls from SSO return 401/403 | `DMS_INTERNAL_API_KEY` mismatch, or the caller's IP isn't in `INTERNAL_API_ALLOWED_IPS` | Compare the key in both systems' env files (not the unused root `.env.prod`); confirm the call is loopback | Sync the key; confirm SSO calls DMS over `127.0.0.1` | Retry the SSO admin-console action |
| `[vault] KEK SELF-TEST FAILED` at boot | Configured `VAULT_MASTER_KEY` doesn't match what already-stored documents were encrypted under | Compare against the escrowed key for this environment | **Stop — do not let anyone upload** until resolved; this is not a warning to work around | Restart, confirm `[vault] KEK self-test passed` |
| Uploaded documents 404 after a redeploy | `STORAGE_LOCAL_PATH` unset/relative and the process's cwd changed | Check the startup log's `StorageAdapter: using local filesystem` base path | Set an absolute `STORAGE_LOCAL_PATH`; if a new empty store was created, copy the real store back into place | Confirm the logged base path matches the real corpus location |
| Every outbound email goes to one unexpected address | `EMAIL_REDIRECT_TO` accidentally set in production | Boot should have already refused — if it somehow didn't, check `.env.production` directly | Delete the line entirely (never "widen" the guard) | Boot guard passes, and/or a real test email reaches its real recipient |
| A document/letter/form is stuck `IN_REVIEW`/`PENDING_AUDIT` with no movement | Assigned approver/auditor is deactivated or the named role is unstaffed | `GET /approvals/:itemType/:itemId/chain` for the current step's assignee | Admin `reassign` (`approval:admin`) to a different person | Chain view shows the new assignee, decision proceeds |
| Approval SLA breaches show no escalation action | Legacy workflow engine's `escalationRole` is captured but not acted on by the worker — a documented gap, not a bug | `isSlaBreach`/`sla_breached_at` flags are set correctly | Manually reassign; this is not automatic today | — |
| A document stuck at `ocrStatus: pending` | OCR worker down, or a `PDF_PENDING` backlog not yet requeued | `GET /operations/pipeline-metrics`'s `ocr.available`; `GET /operations/outbox` for a stuck `OCR`-channel row | Restart the worker process; boot-time requeue picks up any backlog | Metric counts advance, document's `ocrStatus` updates |
| A dashboard-wide slowdown correlated with many simultaneous logins | `/operations/health` probe-storm (pre-fix behavior) or genuine `DB_POOL_MAX` saturation | `pg_stat_activity` connection count vs `DB_POOL_MAX`; confirm the health-check fix (§26.7) is actually deployed | Ensure the cached/single-flight health-check version is running; consider `admissionControl`'s `REQUEST_ADMISSION_MAX` tuning | 503s with `Retry-After` instead of universal slow timeouts under real overload |
| Frontend production build bakes in `http://localhost:7100` | `frontend/.env.local` exists on the build machine (Next loads it over `.env.production`) | `Get-ChildItem frontend/.env.local` | Delete the file; it must never exist | Rebuild; `NEXT_PUBLIC_API_BASE_URL` in the bundle matches `.env.production` |
| Signing/audit records the wrong signer IP | A raw `x-forwarded-for` header was trusted instead of `req.ip` (a previously-real, now-fixed vulnerability) | Confirm `TRUST_PROXY` is `loopback`, never `true` | Never set `TRUST_PROXY=true` | Signer IP in the signature record matches the real Apache-forwarded value, not a client-supplied one |
| A staged document purge won't approve | Same user attempted both stage and approve (maker–checker rule, D12) | Check `purge_pending.staged_by_id` vs the approving user | Have a **different** authorized user approve | Approval succeeds, Certificate of Destruction issued |
| Letters cross-reference links can be edited by a read-only oversight role | `letter:read`-gated mutation routes (a previously-real defect, "L9") | Confirm the deployed version gates link create/delete on `letter:create` | Update to the fixed version | Read-only role gets 403 on link mutation attempts |

---

## 30. Development Guide Specific to DMS

### 30.1 Project setup

```
docker compose -f docker-compose.dev.yml up -d   # postgres, redis, minio, meilisearch, mailhog, clamav
npm install                                       # ONCE, from the repo root — npm workspaces
cd backend && cp .env.example .env                # fill in the secrets it names
npm run db:setup                                  # migrate + seed-core (demo data)
npm run dev                                        # :7100 — starts API + BullMQ worker together in dev
cd ../frontend && cp .env.development.example .env.development
npm run dev                                        # :7101
```

Health check: `GET http://localhost:7100/health`. API docs at `http://localhost:7100/api-docs` when `ENABLE_API_DOCS=true` (dev default). The backend degrades gracefully when MinIO/Meilisearch are down — convenient, but also a trap: a dev box with a misconfigured `MINIO_ENDPOINT` never actually exercises the real storage path (`backend/.env.example` documents why every host in it is `127.0.0.1` rather than `localhost` — to make a misconfiguration fail loudly instead of silently resolving to the wrong thing).

### 30.2 Running it

`npm run dev` at the repo root runs both workspaces concurrently (`concurrently`). Demo accounts (from `db:seed:core`, all `@edams.local`, all in the `examplecorp` tenant): `admin@`, `manager@`, `officer@`, `approver@`, `employee@`, `auditor@`, `chief@` plus per-department variants — passwords bypassed via `LOCAL_JWT_MOCK=true`, offered as quick-pick buttons on the dev login page.

### 30.3 Modifying the frontend

Add a page under `app/` (App Router conventions — `page.tsx`, route groups in parens for layout-only grouping). Add a feature under `features/<name>/` with its own `hooks.ts` (TanStack Query wrappers), `api.ts` (typed `apiClient` calls), `types.ts`. Gate new UI on `can(permission)`/`<PermissionGate>`, never a role string.

### 30.4 Modifying the backend / adding an API endpoint

New endpoint: add a route in the relevant `modules/<name>/*.routes.ts` (transport only — parse request, call service, shape response), implement the logic in `*.service.ts`. Decide public vs protected placement in `api/v1/index.ts` deliberately (§2.4) — a route needing no DMS account (external signer, QR verification) belongs on the public router; everything else on the protected one. Add a new permission to `config/permissions.ts`'s `PERMISSIONS` object and grant it to at least one role in `ROLE_PERMISSIONS` before gating a route on it.

### 30.5 Adding a database change

New migration: a new numbered `.sql` file in `backend/migrations/` (`YYYYMMDDNNNNNN-description.sql`) **plus** its paired `.down.sql`. Follow **expand/contract** discipline (`Documentations/rollout.md` §3) for anything with live users depending on it: add a column nullable first, deploy the code that can use it, let it run, and only later (a separate deploy) make it required/clean up — never both steps in one deploy, since the down-migration path is not treated as a reliable safety net for a live system. Add the corresponding Sequelize model (one file per table, `infrastructure/database/models/`), wire associations in `associations.ts`, and export from `index.ts` — **never import a model from its own bare file**, only from `index.ts`/`associations.ts`, or association wiring won't have run.

### 30.6 Adding a workflow / document type / permission / integration / worker / test

- **New document type**: `POST /document-types` with the desired `reapprovalPolicy`/`auditPolicy`/`signingPolicy` — no code change needed for a type using existing policies.
- **New approval chain shape**: `POST /approvals/templates` (admin) — no code change for a new chain recipe on an existing item type.
- **New permission**: §30.4 above.
- **New worker**: implement `create<Name>Worker()` in `infrastructure/queue/workers/<Name>Worker.ts` following the existing pattern (BullMQ `Worker` + `Queue`, wrapped in `attachErrorLogger`), register it in `workers/index.ts`'s `startWorkers()`.
- **New integration** (e.g. a new outbound webhook event type, a new email template): add the template to `infrastructure/email/templates.ts`'s registry (never hand-build an email inline); for a new outbox-dispatched side effect, add a channel/type to `outbox.ts` rather than performing it inline in a request handler.
- **New test**: Jest suite in `backend/tests/*.test.ts` for anything reachable without a live server; a live-HTTP verifier in `backend/test-scripts/` (not `scripts/` — that directory is for *operating* the system, not proving it works) for anything that genuinely needs a running backend + real DB.

### 30.7 Validation / deploying changes

`npm run typecheck` (both workspaces), `npm --workspace backend run lint` / `npm --workspace frontend run lint`, `npm test`, `npm run e2e` (against running dev servers). Deployment procedure: §23.

---

## 31. Extension and Integration Guide

### 31.1 API integration (a future system or external consumer)

Everything under `/api/v1` is the sanctioned integration surface. Per `Documentations/rollout.md` §2's stated API-versioning discipline: **additive** changes (new endpoint, new optional request field, new response field, a new enum value nothing rigidly branches on) need no special process — just add them to `/api/v1`. A genuinely **breaking** change (rename/remove/change-the-meaning-of an existing field) must go to a scoped `/api/v2` for the *specific* endpoints that changed, keep `/api/v1` untouched and working, mark v1 deprecated with at least 90 days' notice before removal, and share the same underlying service logic between both versions unless the logic itself is what changed.

### 31.2 SSO integration pattern (Mode A — real OIDC client)

Fully described in §7.3. This is the pattern a *new* relying-party system on this platform should follow if it wants a first-class, JIT-provisioned identity — as opposed to GMS's different, token-bridge pattern (a platform-level architectural choice, not something DMS itself needs to know about beyond "we are Mode A").

### 31.3 Authentication for a new integration

An external system calling DMS's API on behalf of a real user should go through the same OIDC flow any browser client does — there is no separate machine-to-machine OAuth client-credentials grant implemented. An external system needing DMS to call *into* it (not the reverse) should register a **webhook subscription** (§31.5) rather than polling.

### 31.4 Authorization requirements for a new integration

Any new caller needs a role/permission combination that already exists or a new permission added per §30.4 — there is no separate "API key with its own permission set" concept for ordinary integrations (the one exception, `/internal/roles`, is purpose-built exclusively for the SSO admin console and is not a general integration pattern to imitate).

### 31.5 Notifications / webhooks for external consumers

`POST /webhooks` (`operations:manage`) registers a subscription with a callback URL; DMS delivers domain events (document lifecycle changes, letter events, etc. — whichever event types are wired into the `WEBHOOK_EVENT_TYPES` set in `outbox.ts`) as HMAC-SHA256-signed HTTP callbacks (`X-DMS-Signature` header, computed over the raw payload with the subscription's own secret — per-subscription isolation, so a compromised secret only affects that one subscriber) with `X-DMS-Event-Id` for consumer-side dedupe (at-least-once delivery — a consumer **must** dedupe on this id, since a transient failure can cause a legitimate redelivery). Delivery is tenant-scoped.

### 31.6 Documents / workflows for a new integration

A document uploaded via the standard `POST /documents` path automatically gets encryption, ACL, audit, OCR, and search indexing "for free" — this is the same reasoning `document_bundles` compilation relies on (§3.1): always integrate through the *normal* document pipeline rather than a parallel one, so every downstream guarantee (encryption, audit trail, retention eligibility) applies automatically rather than needing to be reimplemented per integration.

### 31.7 Shared infrastructure / cross-system navigation

DMS shares the Postgres *instance* (not database) and the Apache reverse proxy with GMS/SSO on the live server, but owns its own database, document store, Redis logical DB index, and queues entirely — there is no shared application-level infrastructure to integrate against beyond the identity layer (§31.2) and the platform's shared reverse-proxy path convention (`/dms` prefix).

### 31.8 Data boundaries

Every tenant-scoped table carries `tenant_id`, enforced by RLS in production under the least-privilege `edams_app` role — a new integration must never bypass this by connecting as a superuser or by constructing queries that skip the tenant-scoping the ORM layer already provides.

### 31.9 Security requirements for a new integration

Never hand-build a raw SQL string with interpolated user input (§26.3); never trust a client-supplied IP header for anything security-relevant (§26.1, §17.3); any new externally-reachable endpoint that doesn't require a DMS account (like the CAMS QR-verify page or external e-signing) must be deliberately placed on the **public** router with its **own** independent rate limit, exactly like `lettersPublicRoutes`'s verify endpoint and `esigningPublicRoutes`.

---

## 32. Architectural Decisions and Rationale

### 32.1 Production environment isolation (no layered `.env` + `.env.production`)

**Decision**: production reads `.env.production` and nothing else; `.env` is never read when `NODE_ENV=production`. **Context**: a layered arrangement (dev `.env` supplying defaults, `.env.production` overriding specific keys) looks strictly more convenient. **Why rejected**: dotenv only overrides keys the overriding file actually *names* — any key `.env.production` doesn't mention silently keeps its *developer* value in production. **Measured cost**: a real 2026-09-05 production launch inherited a personal Gmail address into `EMAIL_REDIRECT_TO`, the dev database, and no `STORAGE_LOCAL_PATH` this exact way; separately, `.env`'s own `NODE_ENV=development` first line clobbered the launcher's `NODE_ENV=production` under `override:true`, disabling every boot guard at once. **Current status**: fixed, identically, across GMS/DMS/SSO — a platform-wide rule, not DMS-specific. **Future consideration**: any new config-loading change must preserve strict single-file isolation; `tests/envLoadingContract.test.ts` is the guard against regression.

### 32.2 Conditional MinIO/Meilisearch requirement

**Decision**: MinIO and Meilisearch credentials are required only when their respective `STORAGE_DRIVER`/`SEARCH_ENGINE` selects them. **Context/alternatives**: the original schema marked them unconditionally required. **Why changed**: the Example Corp production server runs local-disk storage + Postgres search natively, with neither service installed — the unconditional requirement was a literal boot-blocker for the system's actual, intended production configuration. **Current status**: `.default("")` plus a `superRefine` cross-field check. **Future consideration**: any new optional subsystem must follow the identical shape.

### 32.3 Storage architecture — pluggable adapter, local-disk in production

**Decision**: a `StorageAdapter` interface with `local`/`minio` implementations, selected by env var, not compiled-in. **Rationale**: lets the same codebase serve both a minimal native deployment (this server) and a fuller Docker Compose deployment (object storage, versioning) without a fork. **Constraint accepted**: local-disk means no independent scaling of storage I/O and no built-in object versioning on the production server today — accepted because MinIO was never installed there and the local-disk path already meets the actual requirement.

### 32.4 Org-unit flattening — sister companies as siblings, never nested

**Decision**: `org_units` are always flat, direct children of the tenant; only `Department` nests under an `OrgUnit`, only `FolderNode` nests under a `Department`. **Context**: an earlier design pass allowed `org_units.parent_unit_id` to actually be set, letting an org unit nest under another. **Why reverted**: this let a branch render as a *child* of HQ in the tree UI instead of HQ's peer — wrong in business-model terms (sister companies sit *alongside* each other, "distributed creation, centralized visibility," not inside one another). **Current status**: migration `20260707000001-flatten-org-units.sql` reparented previously-nested test-data artifacts (repeated `verify-cams.ts` runs had created a "Test Branch" under HQ with no cleanup); the API (`orgUnits.routes.ts`) never sets or accepts `parentUnitId` any more; the frontend's "New Sub-Unit" context-menu action was removed for the same reason. **Column retained**: `parent_unit_id` still exists in the schema for stability — nothing else references it — rather than being dropped, since dropping a column is a one-way door and there was no pressing need to take it.

### 32.5 Worker/API process split

**Decision**: the API and the BullMQ workers run as two separate OS processes in production (`ENABLE_QUEUE_WORKERS=false` in the API's env). **Context**: originally one process. **Trigger**: a 2026-08-28 incident — a native segfault inside a PDF-OCR rasterization library took the whole API process down mid-request whenever it hit certain letterhead/scan PDFs. **Fix**: split, mirroring `docker-compose.prod.yml`'s long-standing backend/worker service separation, which the native deployment had drifted from. **Current status**: three console windows in production (API, worker, frontend), not two. **Future consideration**: this is now the enforced topology — reintroducing in-process workers to the production API would reintroduce the exact blast-radius problem the split fixed.

### 32.6 Audit-write atomicity via `runInTransaction()` (not Sequelize's managed callback form)

**Decision**: a dedicated `runInTransaction()`/`afterCommit()` helper, used everywhere a service-level write must be atomic with the rest of the request. **Context**: Sequelize 6's CLS integration auto-injects the ambient transaction into individual *queries* that omit an explicit `{transaction}` option, but does **not** make the managed-callback form (`sequelize.transaction(async t => ...)`) join an already-open ambient transaction as a savepoint. **Consequence discovered**: `writeAuditLog` and ~30 other call sites used the managed-callback form, each silently opening a **second, non-atomic** connection per call — an audit write could "succeed" independently of whether the domain change it was recording actually committed. **Fix**: `runInTransaction()` reuses the request's already-open transaction when one exists; anything needing to run only after a *real* commit uses `transaction.afterCommit()`. **Current status**: `tests/auditAtomicity.test.ts` pins the guarantee down. **Constraint for future code**: never write a bare `sequelize.transaction(async t => ...)` inside a request handler's call graph.

### 32.7 Unified approval engine alongside the legacy workflow engine (deliberately not merged)

**Decision**: build a new, more expressive approval engine (`modules/approvals/`) for documents/forms rather than extending the legacy `modules/workflow/` engine. **Context/alternatives**: the legacy engine (fixed-stage, role-only assignment, no locked/unlocked step distinction, no audit stage, no per-type signing policy) could theoretically have been extended incrementally. **Why a new engine**: the SYSTEM-DECISIONS.md review process (D1–D14) specified a materially different model (author-completed templates with locked mandatory steps, a distinct audit stage, per-type signing policy) that didn't map cleanly onto the legacy schema. **Current status**: both are live; letters deliberately were **not** migrated onto the unified engine ("letters keep their proven implementation meanwhile," an explicit, still-open item in SYSTEM-DECISIONS.md's "still open" list) — a scope decision, not an oversight.

### 32.8 SSO's internal-roles back-channel authenticated by shared secret, not JWT

**Decision**: `/internal/roles/*` uses a shared-secret + IP-allowlist scheme (`requireInternalApiKey`), entirely separate from the normal `authenticate` JWT chain. **Rationale**: the caller is the SSO admin console acting on behalf of an SSO admin who has no DMS user session to present a DMS JWT under — there is no DMS identity to authenticate as. **Security compensations**: loopback-only IP allowlist (the only real caller is the SSO backend on the same host), a rate limiter applied *before* the key comparison (so a key-guessing loop is throttled before it ever reaches the comparison, and rejections themselves can't be used as an unlimited timing oracle), and every write still audit-logged with the asserted actor identity carried in `actionDetails` (never `audit_logs.user_id`, since the actor may not correspond to any DMS user row at all).

---

## 33. Known Limitations and Technical Debt

### 33.1 DMS/EDAMS naming split (permanent, by necessity, not oversight)

`DMS` is the current product name; `edams`/`EDAMS` persists throughout the token/DB contract (`EDAMS_ROLES_CLAIM = 'https://edams.examplecorp.com/roles'`, `idp_role_mappings.relying_party = 'edams'`, MinIO user `edams-storage`, the `edams_app` DB role, etc.). A prior attempt to rename these to `dms`/`DMS_ROLES_CLAIM` **broke SSO login for every DMS user** (roles resolved to none/unknown) because `idp_role_mappings` had rows seeded under `'edams'` and the rename didn't migrate them — reverted (DMS repo commit `ca06550`). **This is permanent technical debt that must not be "cleaned up" casually** — doing so safely requires a coordinated DB migration across both the DMS and SSO repos simultaneously, not a DMS-only rename.

### 33.2 Legacy workflow engine's `escalationRole` is inert

Captured in the `WorkflowStage` schema, rendered in the definitions UI, but **never acted on** by `WorkflowWorker` — a breached SLA is flagged, never auto-reassigned. Stated explicitly as a documented gap, not a silent bug.

### 33.3 Letters not yet migrated onto the unified approval engine

An explicit, still-open item — letters keep their own proven chain implementation (`letter_approval_steps`) rather than the unified engine's `approval_chains`. Two parallel approval-chain implementations exist in the codebase as a result; this is a stated scope decision (SYSTEM-DECISIONS.md's "still open" list), not an inconsistency someone forgot to resolve.

### 33.4 QR/hash authenticity layer stays letters-only (D8b)

A platform-wide "approval authenticity layer" (hash + QR + signatory) for generic documents/forms was proposed in the original review and explicitly **not** adopted (D8b) — the public `/verify` page and QR mechanism serve letters only. Documents/forms rely on the e-signing ceremony + audit log for their integrity story instead.

### 33.5 PKI subsystem parked, not deleted (D8d)

A self-managed CA + real RSA-signature capability exists, fully unwired, as an intentional head start for a possible future PAdES build with cryptographic, Acrobat-verifiable signatures. No further investment planned unless that build is greenlit.

### 33.6 HashiCorp Vault backend unvalidated against a live Vault server

The `hashicorp` `VAULT_BACKEND` client implementation exists and has unit-level test coverage, but no live HashiCorp Vault instance was available in this environment to validate the integration end-to-end. The `env` backend is what the real production deployment actually uses.

### 33.7 Restore drill not yet performed

`DR-RUNBOOK.md`'s drill log shows "pending first drill" — the disaster-recovery *procedure* is written and partially automated (a restore-drill script for the DB half), but has not yet been executed and recorded even once. No numeric RTO exists as a result — only the procedure's steps, untimed in practice.

### 33.8 No dedicated full-text index on the Postgres search fallback

`ILIKE` queries against `documents`/`document_metadata` have no GIN/pg_trgm index — fine at current corpus size, a real future scaling concern if Meilisearch is never deployed and document volume grows substantially.

### 33.9 Request-transaction hold time spans slow non-DB I/O

ClamAV scans, PDF rendering, and MinIO round-trips execute while the request's DB transaction is still open (`tenantContext` holds the connection for the whole request) — the structural fix (stop the transaction from spanning that work) is identified but not yet implemented; today the mitigation is solely `DB_POOL_MAX` sizing and `DB_STATEMENT_TIMEOUT_MS`/`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` bounds.

### 33.10 Single-instance deployment

Every multi-instance-readiness primitive (Redis rate-limit store, Socket.IO Redis adapter, role/ACL caches, configurable pool, graceful drain, orphaned-storage sweeper, TZ pinning) exists specifically so a second instance could be added without an application-code change — but no second instance has ever actually been run, so this readiness is unexercised in practice.

### 33.11 No mobile/browser push notifications

Only in-app + Socket.IO realtime + email exist. Not on any documented roadmap in the materials reviewed.

### 33.12 PDF generation has no size/complexity guard

Letter/form PDF rendering runs synchronously inside the request with no identified size cap — a pathologically large template or letter body is a direct request-latency risk, unlike OCR/PAdES-signing (both queued/post-commit).

### 33.13 Deferred items from SYSTEM-DECISIONS.md's own "still open" list (P2/P3, not decision-blocking)

Per-tenant letterhead/branding polish, Amharic Unicode PDF font work beyond letters, rich-text letter bodies, an incoming-letter acknowledge-receipt action, CC/distribution lists, a dedicated CLOSED audit event for letters, full `assertTransition` coverage, SLA reminders escalating into an actual daily digest (in-app/websocket notifications ship today; the digest doesn't), tus wiring into the main upload wizard (tus exists and works, just isn't the wizard's default path), PDF text extraction beyond the current OCR pipeline's scope, a disposition PRESERVE decision + Certificate-of-Destruction register UI, bulk restore (bulk operations exist; restore isn't one of them yet), notification preferences beyond what's shipped, scanner/email ingestion automation (D13's proposed build order: batch-upload flow → monitored-mailbox ingestion → watched network folders — none of the three yet built), delegation/out-of-office for approval assignment, and a case/matter concept to unlock the fourth retention trigger (case-closed, D11 — deferred pending that concept existing at all).

---

## 34. Complete System Inventory

### 34.1 Modules (33 backend + 18 frontend feature dirs)

See §3.1/§3.2 for the full annotated table.

### 34.2 Services

One `*.service.ts` per module (or several for larger modules — e.g. `documents/` has `documents.service.ts`, `lockService.ts`, `previewService.ts`, `trashService.ts`, `bulkService.ts`, `documentCrypto.ts`, `DocumentStateMachine.ts`, `statusPermissions.service.ts`; `letters/` has `letters.service.ts`, `letterPdf.ts`; `approvals/` has `approvals.service.ts`, `auditStage.service.ts`, `myWork.service.ts`).

### 34.3 Routes/APIs

~180 distinct HTTP endpoints across 30 route files — full reference in §6.

### 34.4 Database entities

63 Sequelize models — full annotated list in §5.4; raw file listing in `backend/src/infrastructure/database/models/` (`AccessRule` through `WorkflowTask`, plus `index.ts`/`associations.ts`/`_shared.ts`).

### 34.5 Workers/Jobs

15 BullMQ workers + 1 outbox poller — full table in §19.

### 34.6 Scripts (`backend/scripts/`, operational — distinct from `test-scripts/`, verification)

Schema/data: `migrate.ts`, `check-migration-safety.ts`, `seed-reference-data.ts` (production-safe), `seed-core.ts` (demo data despite the name), `seed-reset.ts`, `backfill-plaintext-hash.ts`, `backfill-approval-participant-acl.ts`, `backfill-pades-signed-copies.ts`. Storage/crypto: `reconcile-storage-usage.ts`, `sweep-orphaned-storage.ts`, `find-orphaned-folders.ts`, `generate-rsa-keys.js`, `generate-esign-cert.js`, `rewrap-deks.ts`, `rewrap-ca-keypair.ts`, `dr-decrypt-version.ts`. Backup/ops: `db-backup.ts`, `storage-backup.ts`, `register-backup-task.ps1`, `run-with-env.cjs`, `verify-prod-env.ts`, `free-dev-port.cjs`, `rasterize-letterhead.mjs`.

### 34.7 Test-scripts (verification, `backend/test-scripts/`)

~30 live-HTTP/live-DB verifiers — full list gathered in §27.4; `run-all-verifications.ts` is the aggregate entry point (`npm run verify:all`).

### 34.8 Tests

52 Jest suites / 478 tests (backend); Vitest suite (frontend); 5 Playwright specs (e2e); 252-case manual checklist (not included in this edition).

### 34.9 Configuration

~75 environment variables across auth, database, storage, search, email, vault, AI, and operational tuning — full reference in §22.2.

### 34.10 Integrations

Platform SSO/IdP (OIDC relying party, client `edams`); MinIO (optional); Meilisearch (optional); ClamAV (optional); an AI provider (opt-in, provider-agnostic — Groq/OpenAI/Anthropic/custom endpoint); outbound webhooks (consumer-defined, HMAC-signed).

### 34.11 Documentation (canonical locations)

`README.md` (run/configure/what it does) → `ARCHITECTURE.md` (reference) → **this document** (deep-dive, supersedes `dms-docs.html`) → `SYSTEM-DECISIONS.md` (authoritative for the approval engine, D1–D14) → `CHANGELOG.md` (history) → `Documentations/rollout.md` (safe-shipping discipline) → `Documentations/` (BRD/FRD/TDD specs, deployment runbooks, `TEST_STATUS.md`). The 2026-07-26 and 2026-09-03 audits are **closed** registers (their reports are not part of this edition) cited by number from ~20 source files — never renumber, never read as open worklists.

### 34.12 Deployment artifacts

`docker-compose.prod.yml` + `.env.prod.example` + `deploy/` (Caddy, Postgres-init, backup sidecar, Prometheus config) — Docker path only. `Documentations/DEPLOY-WINDOWS-MANUAL.md` — the actual live-deployment procedure. `Documentations/DR-RUNBOOK.md` + the platform restore-drill script — disaster recovery. `.github/workflows/ci.yml` — CI. `tools/audit-gate.mjs`, `tools/generate-test-status.mjs`, `tools/create-dms-governance-workbook.mjs` — supporting tooling.

---

## Final Validation Notes

This document was produced by direct inspection of the current source tree in this session — every route table, permission list, config schema entry, state-machine transition, worker list, and deployment procedure above was read from the actual file named beside it (not reconstructed from memory of prior documentation), and cross-checked against `ARCHITECTURE.md`/`SYSTEM-DECISIONS.md`/`README.md`/`CHANGELOG.md`/`Documentations/rollout.md` for consistency. Where those existing docs and the code agreed, both are cited; no contradiction between this document and the code was found during the drafting pass. Sections explicitly marked **[GAP]** are genuine, stated limitations — not smoothed over. This document is the canonical DMS deep-dive entry point — `README.md`, `ARCHITECTURE.md` and `CONTRIBUTING.md` all now point here rather than at the retired `dms-docs.html`.


