# DMS Architecture

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS |
| State | Zustand (auth/UI), TanStack Query (server data) |
| Backend | Express.js 5, TypeScript |
| ORM | Sequelize 6 |
| Database | PostgreSQL 15+ |
| Cache / Queue | Redis, BullMQ |
| Storage | Local filesystem (dev), MinIO (prod) |
| Search | Meilisearch (PostgreSQL fallback) |
| Realtime | Socket.IO |
| Auth | RS256 JWT (JWKS endpoint; dev mock via `LOCAL_JWT_MOCK=true`) |

---

## Frontend Structure

```
frontend/
├── app/
│   ├── (auth)/            # login, select-tenant, select-role
│   ├── dashboard/         # Main document views (browse, upload, search, files, notifications)
│   ├── operations/        # Admin/ops panel (all feature panels rendered here)
│   ├── settings/          # User settings
│   └── page.tsx           # Root redirect
├── features/
│   ├── access-control/    # AccessControlCenter (grant/revoke ACL)
│   ├── admin/             # CRUD panels (tenants incl. TenantMembersModal, depts, folders, doc-types)
│   ├── auth/              # Auth store helpers, login/select-tenant hooks
│   ├── bundles/           # AddToBundleModal, bundle compile API
│   ├── comments/          # CommentsPanel (document threaded comments)
│   ├── documents/         # Document hooks/api/types + VersionDiffModal (compare-versions viewer)
│   ├── hierarchy/         # HierarchyTreeBrowser — nested foldable Tenant→OrgUnit→Dept→Folder tree (operations + browse sidebar)
│   ├── legal-hold/        # LegalHoldConsole
│   ├── letters/           # CAMS letters API/hooks/types
│   ├── operations/        # SystemPanels (incl. CryptoStatusPanel), AuditPanels (rich CSV/JSON/PDF export), WorkflowPanels (task queue) + WorkflowDefinitionsPanel (stage/SLA CRUD), RecordsPanels, ManagerHub
│   ├── retention/         # RetentionConsole (policies, disposal queue, cold restore)
│   ├── roles/             # RoleEditor
│   ├── settings/          # Settings page hooks/types (2FA, profile)
│   ├── signing/           # Electronic/PKI signing API
│   └── users/             # UsersManagementPanel
├── shared/
│   ├── components/        # DataTable (table + mobile card-view), Modal, PermissionGate, TopBar, Sidebar, TenantSwitcher
│   ├── hooks/             # usePermissions
│   └── lib/               # apiClient (401→refresh→retry interceptor), permissions, cn
└── state/
    ├── auth.store.ts      # Zustand auth store (persisted to localStorage under "dms-auth")
    └── ui.store.ts        # Theme, sidebar
```

All backend calls use `NEXT_PUBLIC_API_BASE_URL` (`http://localhost:7100/api/v1` in development). The `apiClient` utility attaches the Bearer token automatically.

---

## Backend Structure

```
backend/src/
├── api/v1/index.ts         # Route mounting
├── app.ts                  # Express app setup, CORS, middleware
├── config/
│   ├── env.ts              # Zod-validated env
│   └── permissions.ts      # ROLE_PERMISSIONS map (static + DB-backed)
├── core/                   # AppError, logger, asyncHandler
├── infrastructure/
│   ├── cache/              # aclCache (in-memory with TTL)
│   ├── database/
│   │   ├── models/         # All Sequelize models (initModels() entry point)
│   │   └── sequelize.ts    # Singleton Sequelize instance
│   ├── queue/              # BullMQ workers (OCRWorker, SearchWorker, AIWorker, RetentionPurgeWorker, outbox poller)
│   ├── storage/            # MinIO client
│   └── websocket/          # Socket.IO server
├── modules/
│   ├── acl/                # ACL grant/revoke routes + service
│   ├── access-rules/       # Tenant-wide / doc-type-scoped ACL grants (deny-first, separate from per-resource acl_entries)
│   ├── audit/              # Immutable hash-chained audit log
│   ├── auth/               # Login, select-tenant, switch-tenant, JWKS, SSO/OIDC callback, 2FA/TOTP, token refresh/revoke
│   ├── bundles/            # document_bundles: ordered grouping + compile-to-document
│   ├── comments/           # Threaded document comments
│   ├── departments/        # Nested department tree (ltree), scoped to an org_unit_id
│   ├── document-types/     # Document type management
│   ├── documents/          # Core document CRUD, versioning (incl. version-diff), signing routes
│   ├── esigning/           # E-signing envelopes: requests/recipients/fields; serial+parallel; internal + external (access_token) signers
│   ├── folders/            # Folder tree, folder contents
│   ├── forms/              # Forms engine: templates (guarded lifecycle) + instances → pdfme PDF → first-class Document
│   ├── legal-hold/         # Legal hold lifecycle
│   ├── letters/            # CAMS correspondence — outgoing/incoming letters, approval chain, dispatch, cross-reference links
│   ├── notifications/      # In-app notifications (Socket.IO push + unread-count)
│   ├── operations/         # Health, metrics, outbox (list/retry), crypto-status (KEK-rotation visibility)
│   ├── org-units/          # CAMS archive spaces (HQ/branch/outlet/sister-company) — flat siblings under the tenant
│   ├── reports/            # Compliance report registry (tenant-scoped, JSON/CSV) + storage analytics
│   ├── retention/          # Retention policies, disposal queue, cold restore
│   ├── roles/              # Role permission management
│   ├── search/             # Full-text search (Meilisearch + Postgres ILIKE fallback)
│   ├── signing/            # Electronic + PKI signing (CA keypair persisted to storage/.ca-keypair.json)
│   ├── tenants/            # Tenant CRUD + membership (GET/POST/DELETE /tenants/:id/members — user_tenants join rows)
│   ├── users/              # User management
│   ├── webhooks/           # Outbound webhook subscriptions (HMAC-SHA256, per-subscription isolation) — mounted at /webhooks
│   ├── workflow/           # Workflow definitions (stages/SLA/approver-role CRUD) + instances/tasks + SLA engine
│   └── ai/                 # AI chat assistant (POST /ai/chat, tool-use) + document AI endpoints
└── shared/
    ├── auth.ts             # requirePermission, requireTenant, JWT decode
    └── resolveACL.ts       # DENY-first ACL resolution engine
```

---

## Design notes worth knowing before you change things

These are the non-obvious decisions behind the current structure. Each one
replaced something that looked reasonable and was not.

| Area | Design note |
|---|---|
| Models | One model file per table under `infrastructure/database/models/`. `models/index.ts` and `models/associations.ts` are the public import surface — import from those, not from an individual model file, so association wiring is guaranteed to have run. |
| Bundles | `document_bundles` / `document_bundle_items` give ordered grouping, and a bundle compiles to a document through the *normal* document pipeline rather than a parallel one — so a compiled bundle inherits encryption, audit, ACL and retention for free. |
| Multi-instance readiness | Row-level security, a Redis-backed rate-limit store, the Socket.IO Redis adapter, role and user-department caches, a configurable DB pool, graceful API drain, TZ pinning and the orphaned-storage sweeper all exist so a second instance can be added without changing application code. |
| Audit durability (ACID) | Every `writeAuditLog` call is **awaited**, not fire-and-forget. The tempting assumption — that `tenantContext`'s CLS transaction auto-joins a managed `sequelize.transaction()` call — is **false**: Sequelize 6's CLS integration only auto-injects the ambient transaction into individual queries that omit an explicit `{ transaction }` option; it never makes the *managed callback form* (`sequelize.transaction(async t => ...)`) join an ambient one as a savepoint. `writeAuditLog` and ~30 service call sites used that form, so each silently opened a second connection with no atomicity to the request. Fixed via `shared/transaction.ts`'s `runInTransaction()`: reuses the request's already-open transaction directly when one exists (no new connection, genuinely atomic), and falls back to a real `sequelize.transaction()` outside a request (workers, scripts). Anything that assumed "the transaction returned = it committed" (ACL cache invalidation, `executePurge`'s storage deletion, the audit chain-tip cache) was moved to `transaction.afterCommit()`. The universal guarantee remains that a failed audit write **propagates and fails the operation** rather than being swallowed — pinned by `tests/auditAtomicity.test.ts`. |
| Permission union | Resolving a user's effective permissions across roles lives in exactly one place, `resolveUnionPermissions(roleNames, tenantId)` in `roles.service.ts`. It was copy-pasted at eight token-issuing sites before; use the helper at any new one, or the sites drift. |

---

## Authentication Flow

### Dev / Local (LOCAL_JWT_MOCK=true)

Two-phase JWT:

1. `POST /auth/login` → returns `preTenantToken` (has `userId`, no `tenantId`) **and** sets HttpOnly `refreshToken` cookie if single-tenant
2. Frontend redirects to `/select-tenant` if multi-tenant
3. `POST /auth/select-tenant` with `preTenantToken` → returns full `accessToken` (has `tenantId`, `role`, `permissions[]`, `jti`) and sets HttpOnly `refreshToken` cookie
4. All subsequent API calls use `Authorization: Bearer <accessToken>`

`POST /auth/switch-tenant` — exchanges current token for one with a different `tenantId`; rotates the refresh cookie to the new tenant scope.

`POST /auth/refresh` — reads the HttpOnly `refreshToken` cookie (HS256 / `JWT_REFRESH_SECRET`), recomputes permissions from DB, issues a new RS256 access token with a fresh `jti`. No refresh token rotation on this call.

`POST /auth/logout` — writes `revoked:{jti}` to Redis with TTL = remaining access token lifetime; clears the `refreshToken` cookie. The `authenticate()` middleware checks the Redis blacklist on every request.

Token claims: all issued access tokens include a `jti` (UUID v4) for revocation tracking. Tokens issued by the dev mock (`DEV_RSA_PRIVATE_KEY`) are RS256; refresh tokens are HS256 (`JWT_REFRESH_SECRET`).

Token storage: `auth.store.ts` persists access token to `localStorage["dms-auth"]`; refresh token lives in HttpOnly cookie (not accessible to JavaScript).

### SSO / OIDC (Production)

Set `AUTH_ISSUER`, `AUTH_JWKS_URI`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` in `backend/.env` to enable.

1. Frontend navigates user to `GET /auth/oidc/authorize` — backend generates a random `state` + `nonce`, stores in Redis (10-min TTL), and redirects to the IdP authorization URL.
2. IdP authenticates the user and redirects to `OIDC_REDIRECT_URI?code=...&state=...`.
3. Frontend POSTs `{ code, state }` to `POST /auth/callback`.
4. Backend verifies `state` against Redis, exchanges code for tokens at `OIDC_TOKEN_ENDPOINT` (or `AUTH_ISSUER/token`), verifies the ID token signature against JWKS fetched from `AUTH_JWKS_URI`.
5. Backend finds or provisions the local user by `email` claim, then issues a standard DMS RS256 access token and refresh cookie — identical to the dev login flow from this point on.
6. Multi-tenant OIDC users receive a `preTenantToken` and go through the standard `select-tenant` step.

JWKS rotation: JWKS keys are cached in-memory (kid → PEM) with a 1-hour TTL. On an unknown `kid`, the cache is force-refreshed once before failing. `POST /auth/oidc/jwks/refresh` (SYSTEM_ADMIN only) forces an immediate refresh.

---

## Route Mounting & Public vs Protected Routers (`api/v1/index.ts`)

Two routers hang off `/api/v1`:

- **Public** (no `authenticate`): `/auth/*`, `/operations/*`, `esigningPublicRoutes`
  (`/signing/:id/recipients/:rid/sign/external` and `/decline/external`), and `lettersPublicRoutes`
  (`GET /letters/verify?ref&hash` — CAMS QR verification; anyone scanning a printed letter must be
  able to verify it without an account, and it returns non-sensitive confirmation data only).
  External signers have **no DMS account** — they authenticate with a scoped `access_token` in the
  request body, so these routes must sit outside the JWT `authenticate` chain. (Session 5 fix: they
  were previously behind `authenticate` and returned 401 to every external signer.)
- **Protected** (`authenticate` → per-user rate limiter → `tenantContext`): everything else, including
  `/documents`, `/forms`, `/webhooks`, and the JWT-gated e-signing routes (create/send/internal-sign/
  internal-decline). Internal decline enforces **caller-is-recipient** in the service, so it needs no
  extra permission gate.

## Workflow Engine (`modules/workflow`)

A `WorkflowDefinition` is a named, versioned, JSON-encoded list of `WorkflowStage`s
(`{ stageNumber, name, assignedRole, slaDurationHours, slaBusinessHoursOnly, escalationRole?,
parallelApproval? }`), optionally scoped to a `documentTypeId` (unscoped = applies to any type) and
flagged `isDefault`/`isActive`. `POST /documents/:id/workflow/start` looks up the document type's
active default definition, creates a `WorkflowInstance` at stage 1, and opens the first
`WorkflowTask` assigned to whichever role the stage names — matched against a user's **full `roles`
array**, not a single legacy role string (a Session 12 RBAC fix). SLA deadlines are computed from
`slaDurationHours` (`slaBusinessHoursOnly` walks only Mon–Fri business hours); a breached task is
flagged `isSlaBreach: true` by `WorkflowWorker` rather than forced into a dead-end `ESCALATED` status,
so it stays decidable. `escalationRole` is captured in the stage schema but not yet acted on by the
worker (no automatic reassignment) — a documented gap, not a silent bug.

Definition CRUD (`GET/POST/PATCH/DELETE /workflow/definitions`, `workflow:read`/`workflow:manage`) is
now reachable from **Operations → Workflow Definitions** (`WorkflowDefinitionsPanel`), including a
stage builder (add/remove/reorder stages, role pickers sourced from `GET /roles`, SLA-hours input,
business-hours and parallel-approval toggles). Previously this table was configurable only by editing
seed data or writing rows directly — the task queue view (`WorkflowTasksPanel`, Operations → Workflow
Queue) only ever showed instances/tasks already created from whatever definition existed.

## E-Signing Engine (`modules/esigning`)

One engine, two surfaces (freeform field placement, or fields resolved from a Phase-7 form).

- **Ordering:** `parallel` (any order) or `serial` (a recipient may only sign once every lower
  `order_index` recipient has signed — enforced with `409 ERR-SIGNING-OUT-OF-ORDER`).
- **Recipients:** internal (matched by `dms_user_id`) or external (issued a `access_token`, 7-day TTL).
- **Completion:** when all recipients sign, the request → `completed`; if
  `completion_action = 'move_folder'`, the document is moved to `completion_target_folder_id` and its
  ACL cache is invalidated.
- **Crypto:** currently records sign/decline/complete events in the hash-chained audit log; PAdES
  byte-range embedding (PKCS#12 + RFC-3161) is a documented production upgrade.

## Forms Engine (`modules/forms`)

Template lifecycle is **state-guarded**: `draft → pending_approval → active → deprecated`
(`pending_approval`/`active` may return to `draft`); illegal jumps raise `409 ERR-FORM-STATE-INVALID`.
An instance is generated from an **active** template via `@pdfme/generator`, stored (MinIO/local), and
registered as a first-class `Document` carrying a **frozen** `template_version`.

## Organization & Folder Hierarchy (`modules/org-units`, `modules/departments`, `modules/folders`)

The repository is a strict four-level tree — **Tenant → Org Unit → Department → Folder** — and
the UI renders it as a single nested, foldable (expand/collapse) tree in every place it appears.

| Level | Entity | Table | Nesting | Meaning |
|---|---|---|---|---|
| 1 (root) | **Tenant** | `tenants` | one root per tenant | The organization (e.g. *Example Corp*). Synthetic root of the tree — every org unit hangs under it. |
| 2 | **Org Unit** | `org_units` | **flat** — always a direct child of the tenant; `unit_type` ∈ HQ / BRANCH / OUTLET / SISTER_COMPANY | Sister companies / sites within the one tenant — headquarters, branch offices, outlets — sitting **alongside** each other, never inside one another. "Distributed creation, centralized visibility." |
| 3 | **Department** | `departments` | self-referencing `parent_id` + `path` (ltree) + `level`, scoped to an `org_unit_id` | A department (Finance, HR, Legal…) inside an org unit; may nest into sub-departments. |
| 4 | **Folder** | `folder_nodes` | self-referencing `parent_id` + `path`, bound to a `department_id` | Category folders and sub-folders holding the actual documents. |

**Org units never nest.** `org_units.parent_unit_id` still exists in the schema (kept for stability;
nothing else references it — see `associations.ts`) but `orgUnits.routes.ts` never sets or accepts
it: create always writes `parentUnitId: null`, and update no longer has a `parentUnitId` field at
all. HQ, each branch, and each sister company are always siblings directly under the tenant — the
self-nesting capability from an earlier design pass was corrected because it let a branch render as
a *child* of HQ instead of HQ's peer. Migration `20260707000001-flatten-org-units.sql` reparented
any previously-nested org unit (test-data artifacts from repeated `verify-cams.ts` runs, which
created a "Test Branch" under HQ on every run with no cleanup) back to top-level. The frontend's
"New Sub-Unit" context-menu action was removed for the same reason — only "New Org Unit" (always
top-level) and "New Department" (nests under the clicked org unit) remain.

**Why two structures exist.** `folder_nodes` is a *materialized* folder tree (levels 0–3:
Repository → Organisation → Department → Category) used for document placement and ACL ancestry
walks. `org_units` + `departments` are the *authoritative* organizational entities. The UI tree is
built from the **entities** (org units + departments) with their folders lazy-loaded underneath, so
it reflects multiple sister companies correctly — the materialized `folder_nodes` root only carries
a single organisation node and cannot represent more than one org unit on its own.

**Frontend — one shared component, two mount points.** `features/hierarchy/HierarchyTreeBrowser`
is the canonical tree. It renders a synthetic **tenant root** (auto-expanded), lazy-loads org units
flat under it (`GET /org-units`), then departments per unit (`GET /departments/tree?orgUnitId=`),
then folders per department (`GET /folders?departmentId=&parentId=null`) and sub-folders
(`GET /folders/:id/contents`) as each node is expanded. Org units show a `unit_type` badge (HQ /
Branch / Outlet / Sister Co.). Icons: tenant = network, org unit = landmark, department = building,
folder = folder. Long names truncate with an ellipsis (`title` tooltip shows the full name) instead
of wrapping, and the compact sidebar variant uses a tighter indent scale — both fix an overflow bug
where a long org-unit name wrapped to multiple lines and pushed its badge/code past the card edge.

- **Operations → Hierarchy Browser** mounts it in full `browse` mode (context-menu CRUD: create
  department / sub-folder, rename, manage access, deactivate — no "New Sub-Unit"), passing `tenantName`.
- **Browse (Document Repository) sidebar** mounts it in `select` + `compact` mode. Selecting a
  folder drives the document pane directly (folder nodes carry a real `folder_nodes.id`); selecting
  a department maps to that department's level-2 materialized folder to show its category folders +
  documents; selecting the tenant/org unit resets to the repository root.
- **Operations → Folders** panel (`FoldersCrudPanel`) lists `folder_nodes` as an indented,
  foldable tree (parent-before-child, collapsible rows) rather than a flat table.

`shared/lib/tenant.ts#formatTenantName` turns the tenant slug (`examplecorp`) into the display title
(*Example Corp*) shown at the tree root.

## CAMS — Correspondence & Archive (`modules/letters`, `modules/org-units`)

Digital Correspondence & Archive Management for the Example Corp, built on two owner-confirmed
decisions: **one tenant + `org_units`** (HQ / BRANCH / OUTLET / SISTER_COMPANY archive spaces inside
the `examplecorp` tenant — "distributed creation, centralized visibility"), and **Letter wraps
Document** (final PDFs and incoming scans are filed through the canonical `documentCrypto` pipeline
as `CORR`-type documents, inheriting encryption, versioning, OCR, search, retention, and audit).

- **Outgoing lifecycle:** `DRAFT → IN_REVIEW → (RETURNED → resubmit) → APPROVED → DISPATCHED →
  ARCHIVED` (or `CANCELLED` from DRAFT/RETURNED). Maker–checker–approver chains live in
  `letter_approval_steps` — sequential, exactly one `PENDING` step at a time, last step must be
  `APPROVE`. Draft edits auto-save to `letter_revisions`.
- **Reference numbers** (`REF/UNIT/DEPT/TYPE/YEAR/SEQ`) are allocated **only at final approval** from
  `letter_sequences`, a gap-free per-unit-per-type-per-year counter locked with
  `SELECT … FOR UPDATE` inside the approval transaction. Incoming letters get a `…/IN/…`
  registration number at intake from the same counter mechanism.
- **Final PDF:** rendered with pdf-lib (letterhead, server-stamped date, signatory block from the
  approving user's profile, QR code). The QR encodes `CAMS_VERIFY_BASE_URL?ref=…&hash=…` where the
  hash is a content hash (ref + subject + body + signatory + timestamp); the sha256 of the PDF bytes
  is stored on the letter (`document_hash`) for integrity. StandardFonts are WinAnsi-only, so
  Amharic renders as `?` until a Unicode font is embedded (documented gap).
- **Incoming (6.2):** `POST /letters/register` (multipart `scan`) files the scan encrypted, queues
  `OCR` + `SEARCH_INDEX` outbox events, routes to a department with an optional due date and
  assignee, and can thread itself to an outgoing letter via a `REPLY_TO` link.
- **Cross-reference index (6.3):** `letter_links` (REPLY_TO / RELATED / FOLLOW_UP), queried in both
  directions by `GET /letters/:id/links`.
- **Archive scoping:** `letter:read` sees own departments' letters plus own/assigned;
  `letter:read_all` is the HQ **Central Archive** view across all units.
- **Frontend:** `/dashboard/letters` (tabs + filters), `/dashboard/letters/new`, `…/register`,
  `…/[id]` (approval actions, dispatch log, thread, PDF download), and the public `/verify` page
  (listed in `AuthGuard`'s public paths and exempt from the logged-in redirect).

## ACL Resolution (`resolveACL.ts`)

DENY-first, ancestor-walking:

1. Check direct `acl_entries` for the resource (document/folder/department)
2. Walk folder ancestors (recursive CTE up the `folder_nodes.parent_id` tree)
3. Walk department ancestors (recursive CTE up `departments.parent_id`)
4. Check `access_rules` for tenant-wide or document-type-scoped grants
5. Deny by default if no matching ALLOW found

Cache: `aclCache` (in-memory LRU with TTL; invalidated on ACL changes via Redis `SCAN+UNLINK`). The LRU `set()` correctly moves an existing key to the most-recent end before re-inserting, preventing stale-entry retention under eviction pressure.

---

## Permission Model

Two layers:

- **Layer 1 (Global):** `requirePermission(permission)` → checks `ROLE_PERMISSIONS[userRole].includes(permission)`. DB-backed via `role_permissions` table with static fallback.
- **Layer 2 (Resource):** `resolveACL()` checks `acl_entries` on the specific resource. A DENY at any level blocks access.

Frontend gating uses `can(permission)` and `<PermissionGate permission="...">` — never checks role strings.

---

## Multi-tenancy

- Tenant slug is a readable string (`examplecorp`, `demo-org`) stored in `user_tenants` junction.
- Every DB table has `tenant_id` column. Queries always scope by tenant.
- `TenantSwitcher` in sidebar calls `POST /auth/switch-tenant`.
- **Membership management:** `users` rows are global (no direct `tenant_id` — a user's tenant access
  is entirely determined by their `user_tenants` rows), so adding/removing a user from a tenant is a
  distinct admin action from creating the user. `GET/POST/DELETE /tenants/:id/members`
  (`tenant:manage`) lists/adds/removes membership rows; `POST` accepts any existing active user's id
  (the candidate-user picker draws from the unscoped `GET /users` list, matching how the route itself
  looks the user up — no tenant filter). Surfaced as a **Members** action on each row of
  Operations → Tenants (`TenantMembersModal` in `features/admin/crudPanels.tsx`) — previously this
  had no UI at all and required inserting `user_tenants` rows directly in the database.

---

## Encryption & Key Rotation (`infrastructure/vault/VaultService.ts`)

Every stored file version is encrypted with its own per-**version** Data Encryption Key (DEK,
AES-256-GCM), wrapped (AES-256 Key Wrap / RFC 3394) under a KEK managed by `VaultService` and stored
in `document_deks` (one row per `versionId`, not per document). KEKs are numbered versions
(`DEV_VAULT_MASTER_KEY_V{n}`); a `kekId` embeds the version it was wrapped under, so historical DEKs
stay decryptable after `DEV_VAULT_MASTER_KEY_CURRENT_VERSION` is raised. `scripts/rewrap-deks.ts`
re-wraps existing rows onto the current version (dry-run by default, batched, idempotent/resumable) —
a manually-run script, not an automatic background job. Production HashiCorp Vault is an intentional
stub (`getVaultService()` throws outside `DEV_VAULT_MOCK`) — no live Vault server was available to
validate a real integration against.

**Rotation visibility:** `rewrap-deks.ts` was CLI-only, with no way to see whether a rotation was
outstanding without querying `document_deks` by hand. `GET /operations/crypto-status`
(`operations:manage`, read-only) groups every DEK by its `kekId`'s embedded version and reports the
current version, total DEK count, per-version breakdown, and how many sit behind the current
version — surfaced in **Operations → Crypto / KEK Status** (`CryptoStatusPanel`), including the exact
`rewrap-deks.ts` command to run when out of date.

---

## Key Database Tables

| Table | Purpose |
|---|---|
| `users` | User accounts (no tenant_id or role — those are in JWT/user_tenants) |
| `user_tenants` | Many-to-many: user ↔ tenant with per-tenant role |
| `departments` | Nested via `parent_id` + `path` (ltree) + `level` |
| `folder_nodes` | Nested folders with `parent_id`, `path`, `department_id` |
| `documents` | Central document record (17 lifecycle statuses) |
| `document_versions` | Immutable version history |
| `document_deks` | One wrapped DEK per `versionId` (not per document); `kekId` embeds the KEK version — see "Encryption & Key Rotation" |
| `workflow_definitions` | Named/versioned stage configs (`definition` JSON: `{ stages: WorkflowStage[] }`), optionally scoped to a `documentTypeId` |
| `workflow_instances` / `workflow_tasks` | A document's running workflow (current stage) and its per-stage approval tasks (assignee, SLA deadline, decision) |
| `acl_entries` | Resource-level ACL grants (ALLOW/DENY) |
| `access_rules` | Tenant-wide or doc-type-scoped grants |
| `retention_policies` | Named retention class → period mapping |
| `legal_holds` | Active legal holds with document associations |
| `audit_logs` | Immutable hash-chained event log |
| `outbox_events` | Transactional outbox for async side effects |
| `webhook_subscriptions` | Outbound HTTP callback registrations |
| `form_templates` / `form_instances` | Forms engine — guarded template lifecycle; instance = first-class document with frozen `template_version` |
| `signature_requests` / `signature_recipients` / `signature_fields` | E-signing envelopes, recipients (internal + external `access_token`), and field placement |
| `idp_role_mappings` / `oidc_grants` / `idp_clients` | IdP config — AD-group → DMS-role mapping (per relying-party), grants, and client registry |
| `org_units` | CAMS archive spaces — HQ / branches / outlets / sister companies (unique `tenant_id + code`); always flat siblings under the tenant — `parent_unit_id` column exists but the API never sets it |
| `letters` | Correspondence records (outgoing + incoming); 1:1 `document_id` link to the filed final PDF/scan |
| `letter_sequences` | Gap-free reference counters, PK (`tenant_id, org_unit_id, letter_type, year`), locked FOR UPDATE at allocation |
| `letter_revisions` / `letter_approval_steps` | Pre-approval draft history; maker–checker–approver chain |
| `letter_links` / `letter_dispatches` | Cross-reference index (reply threads); dispatch & delivery tracking |

> **FK convention:** all `*_by` / user-reference columns are `UUID REFERENCES users(id)` (users.id is
> `UUID`); `tenant_id` is `VARCHAR REFERENCES tenants(id)` (tenant ids are slug strings). Mixing `TEXT`
> with the `UUID` PK breaks the foreign key at migration time — the Session-5 forms/esigning fix.
