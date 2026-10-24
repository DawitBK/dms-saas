# Changelog

All notable changes to this project are documented here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Versioning
follows [semver](https://semver.org): patch for fixes, minor for additive
features, major for anything that breaks an existing API contract (see
Documentations/rollout.md §2 for exactly what that means in this codebase).

Work predating this file is not reconstructed here; `git log` is the record for
that. Everything from this point forward gets a real entry.

## [Unreleased]

### Added (2026-10-15: the reference-number prefix is a setting)

- `REFERENCE_NUMBER_PREFIX` (1-8 upper-case letters or digits, default `KG`) is the first segment of every letter and form reference number. It was spelled `KG` in three places in code. The default keeps every number issued so far unchanged; numbers already issued keep their prefix. Set in `.env.example`; read in `letters.service.ts` and `forms.service.ts`. The company-neutral SaaS edition uses `REF`.

### Added (2026-10-15: the vault-owner defect reports itself)
- `GET /api/v1/operations/ready` lists `platform-vault-owner` under `degraded` (and `/operations/health` shows `vaultOwner`) when the platform-vault check functions are owned by the application's own non-superuser role: the state in which every insert into `user_roles` fails with `permission denied for table platform_vault_unlocked`. `scripts/fix-vault-function-owner.sql` fixes it; the platform's uptime monitor alerts on it. 4 tests.

### Fixed (2026-10-15: access rows outlived their documents; retention ids; test organisations; questionnaire layout)
- **The department-data compiler dropped the first four data rows of every sheet in a workbook saved without the template's title rows.** It assumed data starts on row 6; the Marketing workbook has its header on row 1, so Mekdes Tilahun, Cherenet Zergaw, Bona Mengesha and Alemtsehay Guluma, the Annual Marketing Plan, Marketing Strategy, Marketing Action Plan and Campaign Plan, their routes (`WF-MKT-PLAN`, `-STRAT`, and the routes for the other two, which then "matched no type") and four governance rows (retention and signature of `MKT-MARBUD`, `MKT-ANMARP`, `MKT-BRAGUI`, `MKT-CORCOM`) were silently lost, and the profile looked "empty". `firstDataRow` finds the header (4 unit tests). Loaded on dev: 4 types, 4 chains, 3 people; the 4 mis-set types corrected.
- `cleanup-seed-data.ts --org-units` now works on the mirror: it sets the tenant for its transaction (the application role is bound by row-level security and otherwise sees nothing), skips tables the role cannot read (the platform vault) and leaves `users` out of the walk (a policy on `users` reads the vault).
- **Destroying a document left its access rows behind.** `acl_entries` is polymorphic (`resource_type`/`resource_id`, no foreign key), so deleting the document did not cascade: `executePurge` (certified destruction),
  `deleteDraftPermanently` and the letter-attachment delete removed keys, versions, chains and the document but never the grants, which then pointed at nothing for ever (85 such rows were found on dev, from August to October).
  All three now delete them in the same transaction before the document. `tests/trashService.purgeAclCleanup.test.ts` fails without the fix. `cleanup-test-structure.ts` had the same gap for departments.
- **The department-data compiler no longer turns a note into a retention policy.** A cell such as `RET-HR/LEG-No specificed time` became a policy with that sentence as its code; an id must now look like `RET-HR-10Y`, a note is listed as a
  decision, and `decisions.json` `retentionAliases` maps it. A code that reads like one number of years but is written with another (`RET-MKT3` with "10 Years") is listed. The cleanup tool `cleanup-seed-data.ts` gained `--org-units=CODE,...`
  (removes test organisation units with their content by following the foreign keys; refuses if a user account would go).
### Fixed / Added (2026-10-13: form numbers per tenant, three more departments)
- **Form reference numbers were unique across every tenant** (migration `20261013000010`). The number (`REF/<unit>/<department>/FORM/<year>/<n>`) does not name the tenant, so the first form approved in a second tenant
  with the same unit and department codes collided with the first tenant's form on the global index; the allocator swallowed the database error inside the approval's transaction, which left it aborted, and the approval
  answered `500 ERR-INTERNAL`. The tenant is now recorded beside the number (`form_instances.reference_tenant_id`, backfilled for the numbered rows), the unique index is `(reference_tenant_id, reference_number)` like letters'
  `letters_tenant_ref_uniq`, and the allocation runs in a savepoint so any future failure there undoes only itself. Found by the older live verifiers; `verify-form-reference-numbers.ts` now passes 13 of 13.
- **Department data intake handles three more questionnaires** (Customs Clearance and Transit, Equipment Finance, Marketing): any `.xlsx` is read; a sister company gets its own organisation unit (Equipment is `EQUIP`);
  an empty Department Profile is inferred; several managers per department; department resolved by code, name, prefix or as the named manager; written addresses checked against the company directory; sample rows
  recognised by content; retention conflicts and missing rules listed (types with no rule are held back, never created without one); workflows bound by id, workflow id or name. New `decisions.json` keys
  (`orgUnits`, `departments`, `parents`, `retentionYears`, `people`, `accepted`) are described in the Collected-Data README. 19 unit tests.
- `npm run db:cleanup:test-structure` gained `--department=CODE`, `--detach-members` and `--drop-sequences` for structure that is not named like a test but is known to be one (all opt-in, same refusals).
- The 16 older verifiers (`test-scripts/verify-*`, `test-acl-*`) run on dev through `test-scripts/lib/dev-admin.ts`: the QA-world administrator, the `qa-lab` tenant, a second person to approve (self-approval is refused), a guard
  that refuses anything but the local dev backend, and a clear `NEEDS DEMO DATA` exit instead of a crash. `test-acl-batch-equivalence` no longer deletes role rules it did not insert.

### Added / Changed (2026-10-11: error answers and department data intake)
- **State conflicts answer 409, not 400**: e-signing send, sign and remind, restoring a document that is not in the trash, and using a form template that is not active. A malformed request stays `400`.
  Distinct meanings got their own codes instead of sharing one: `ERR-OIDC-STATE-INVALID` (the sign-in `state` parameter), `ERR-BUNDLE-DUPLICATE-IDS` (422), and `ERR-LETTER-ORG-MISSING` and
  `ERR-RETENTION-CONFIG` (server-side data faults, still 500). A client that matched on the old status or code needs the new one. `tests/esigning.workflow.test.ts` pins the 409. Unused imports and
  handler parameters found on the way were removed.
- **Department data intake is a tool** (the Collected-Data README): `npm run db:compile:collected` cleans every `REF-Corp-<Department>-<Person>.xlsx` (typos, DMS-valid codes, sub-departments, role words,
  several record types in one cell, template text, names matched to company addresses with a confidence level) into one compiled file and one review workbook, lists what only a person can decide
  (`decisions.json` answers it; `-- --check` fails until it is empty), and never invents an e-mail address. `npm run db:seed:collected` loads it on a practice copy through the admin services.
  `collectedCleaning.ts` has 16 unit tests. Finance is the first department added this way.
- **`npm run db:cleanup:test-structure`** removes the empty "Test Root / Child / Grandchild Dept" departments, their folders and emptied scratch organisation units that old test runs left behind
  (dry run unless `--execute`; refuses if anything real refers to them; mirror and production need `I_UNDERSTAND_THIS_DELETES`).
- Removed the duplicate npm script `data:compile-collected` (same as `db:compile:collected`).

### Fixed (2026-10-11: parity between the screen, the server and the table)
- **A document's class had two answers in the database** (migration `20261011000010`). `security_classification` and the older `"sensitivityLabel"` were written independently (ten development documents
  were Confidential, Public or Restricted and labelled Internal). The label is now repaired and derived from the class by a trigger on every write, the class has the CHECK it lacked, and the upload schemas no
  longer take a label from the caller. Nothing about who can open a document changes: access always followed the class.
- **The search page's classification filter offered `OPEN`, `SECRET` and `TOP_SECRET`**, which no document can hold, and left out `PUBLIC` and `RESTRICTED`. The four classes now live in
  `shared/lib/classification.ts` and the upload form, the classification control, the search filter and the AI-controls panel all read them.
- **Validators now stop at their column lengths** (about twenty: role name 64 to 50, webhook URL 2048 to 2000 and secret 256 to 255, delegation reason 2000 to 500, workflow version 50 to 20, document
  language 10, originating system 100, confidentiality notice 500, geographic scope 100, external reference 200, ACL principal 100 and permission 50, status-rule status and action 50, user email 255 and names 100),
  and the inputs that feed them got matching `maxLength`. New `npm run parity:check` fails if one drifts.
- Live verifier `verify-qa-behaviours.ts` grew three checks (74): the label follows the class, a write that tries to set the label alone is overruled, a fifth class is refused. New browser spec `e2e/parity.spec.ts`.

### Added / Fixed (2026-10-04: forms and approval-engine follow-ups)
- **Form template scope** (migration `20261004000020`). Templates carry a department / org-unit scope like a document type
  (existing ones stay tenant-wide). Lists are filtered by scope, a template outside the caller's scope reads as not found, filing
  needs the template to cover the filing department, and `approval:admin` only reaches templates inside its own scope.
  Organisation-level roles may publish tenant-wide or per org unit; everyone else picks a department they belong to.
- **Approval recipes are scoped** (department > org unit > tenant-wide, most specific wins) and a recipe can target the approval of
  form templates themselves. With no recipe, a department-scoped template is approved by that department's head and a tenant-wide or
  org-unit template by an organisation-level role; only organisation-level roles can reassign or cancel such an approval. This closes
  "any department manager can activate a company-wide template".
- **Engine fixes**: activating a template version deprecates the older active versions in the same transaction; engine audit
  events for forms carry the backing document id (and the form ids); a form's chain view lists its audit-stage reviews; the hidden
  platform administrator is redacted from chain views and can no longer be named as assignee, delegate or auditor; chain
  participants (and re-assigned auditors) get read on a form's attachments, not only its PDF; the fill dialog resolves the same
  recipe the engine will use.
- **Filer lifecycle for forms**: save as draft, edit (new minor version of the same document) while DRAFT / CHANGES_REQUESTED /
  DECLINED, withdraw from review, cancel; audited. A required file field no longer needs its name echoed into `dataJson`.
- **Delegation and escalation** in the unified engine: the assignee may delegate a non-mandatory step to one eligible colleague
  of the item's department; an overdue step escalates (after `APPROVAL_ESCALATION_GRACE_HOURS`, default 24) to the department
  head(s), else the approval admins, as co-deciders. New audit events `APPROVAL_STEP_DELEGATED`, `APPROVAL_STEP_ESCALATED`,
  `FORM_INSTANCE_EDITED/WITHDRAWN/CANCELLED`; notification types `APPROVAL_STEP_DELEGATED`, `APPROVAL_STEP_ESCALATED`,
  `APPROVAL_WITHDRAWN`. Config: `APPROVAL_DELEGATION_ENABLED`, `APPROVAL_ESCALATION_ENABLED`, `_GRACE_HOURS`, `_MAX_TARGETS`.
- Needs the migration on every environment (live: after the rebuild, `db:migrate:prod`).

### Fixed (2026-10-04: organisation scope, approvals separation of duties, search leaks)
- **Department and user administration is now scoped** (`shared/orgScope.ts`). A holder of
  `department:manage` / `user:manage` (the default DEPT_MANAGER) used to administer the whole
  tenant. Now a department head administers their own department and its sub-departments only,
  cannot create a top-level department, cannot manage a user who holds a permission they lack
  (a SYSTEM_ADMIN, auditor, records officer, executive), and cannot touch users of another
  tenant. Creating a user requires a department the creator heads and no longer accepts a
  department of another tenant or the platform-admin role. PATCH `{ isActive: false }` on a
  department now applies the same checks as DELETE.
- **Role definitions are organisation-level.** `POST /roles` and `PUT /roles/:id/permissions`
  need `acl:bypass_admin`; `role:manage` was removed from the static DEPT_MANAGER default (it let a
  department manager rewrite any role for the whole tenant). Per-user permission overrides check
  tenant membership.
- Folders: creating at the tenant top level needs organisation authority or `document:read_all`;
  a head may create in sub-departments; naming a second department next to an own-department
  parent, re-pointing a folder at another department, or moving it into one you do not head is
  refused; a department head can rename folders in their subtree without a folder ACL row.
- Document types: the department / org unit a type is scoped to must belong to the tenant; a
  holder of `doctype:manage` without oversight is limited to departments they head. Approval
  templates and legacy workflow definitions must target a document type / form template of the
  same tenant, and template approvers must be tenant members.
- **No self-approval** in the approval engine and the legacy workflow engine; a step cannot be
  addressed by name to the item's author or submitter.
- Search: the Restricted-label rule compared `'RESTRICTED'` to the stored `'Restricted'` and never
  fired; facet counts counted documents the caller cannot read; Meilisearch filter values are now
  escaped. Storage analytics need `document:read_all`; document preview is `Cache-Control: private`.
- Tests: `orgScope.routes`, `users.createScope`, `roles.overrideScope`, `workflow.scope`,
  `search.acl`, `reports.storageGate`, extended `approvals.engine`, `folders.transactional`,
  `permissions.matrix`. Live check: `test-scripts/verify-org-scope.ts`. Reference:
  `Documentations/ROLE-SCOPE-MATRIX.md`.

### Added (2026-09-22: structured letter body editor)
- Letter `bodyHtml` is now a structured document (paragraphs, lists, tables,
  images, links, blockquotes, page breaks — full mark set: bold/italic/
  underline/strike/super/subscript/color/highlight/font family/font size),
  not a plain textarea. Backend schema + PDF renderer: `letterBodyDoc.ts`,
  `letterBodyPdfRenderer.ts` (draws directly with pdf-lib, reusing
  `letterPdf.ts`'s existing letterhead/font/pagination machinery). Frontend
  editor: TipTap, `frontend/shared/lib/letterBodyExtensions.ts` +
  `shared/components/letterBody/`. Inline images upload to a new
  `letter_body_images` table (own storage adapter) instead of being inlined
  as base64. Every letter written before this feature keeps working
  unchanged — `parseLetterBody()` wraps legacy plain text transparently.
- New migration `20260922000001-letter-body-images.sql`.

### Fixed (2026-09-22: Word/WPS paste + editor↔PDF visual parity)
- A pasted Word/WPS table's legacy attribute values (`align="justify"`/
  `"char"`, `vertical-align: center`, colors as CSS2 system-color keywords
  like `windowtext`) used to fail schema validation outright ("Validation
  failed", no detail) — normalized on the frontend at the point of
  authoring instead of rejected; the schema's error now also reports the
  exact failing path instead of a generic message.
- A table cell's `valign` was parsed but never actually applied when
  drawing the PDF — cells always drew from the top regardless of the
  attribute, so a cell with real vertical alignment looked different in
  the editor than in the rendered PDF.
- Custom font sizes rendered ~25% smaller in the editor than in the PDF
  (a units bug: the same number was used as CSS pixels in the browser and
  as points in pdf-lib).
- The final, numbered letter PDF (`generateLetterPdf`) and the signable
  draft PDF the signatory actually signs (`generateLetterSignableDraft`)
  reserved different amounts of vertical space for their top-right header
  block (2 lines vs. 1), so the body content — and the recorded signature
  field's page/position — silently shifted by one line between what was
  signed and what shipped. Pre-existing, not introduced by the above; found
  auditing a "page numbers out of sync" report.

### Fixed (2026-07-23 — Sessions 23-25: Letters/Forms/Signing/Settings UI↔backend parity)
- Forms: `ApprovalChainCard` hardcoded `itemType: 'DOCUMENT'`, making filled forms
  unapprovable (their chain lives under `FORM_INSTANCE`). `GET /documents/:id` now returns
  `formInstanceId` so the frontend knows which kind of chain to query.
- Forms: `createFormInstance`'s auto-submit failure warning (`approvalWarning`) was set on
  a Sequelize model instance and silently dropped by `Model#toJSON()` before reaching the
  HTTP response — now returned as a sibling field and surfaced as a toast.
- Letters: default approval chain offered nonexistent roles (`RECORDS_MANAGER`/`ADMIN`),
  guaranteeing a 422 on submit — fixed to real roles (`DEPT_MANAGER`/`APPROVER`/`SYSTEM_ADMIN`).
- Signing: Governance tab read a disconnected legacy data model instead of real ceremony data.

### Added (2026-07-23 — Sessions 23-25)
- `features/forms/` module (Templates / Fill / My Submissions), template versioning,
  real file-upload for file-type form fields, `basePdfObjectKey` upload endpoint.
- Real `SignaturePad` (draw/type) and `PdfFieldPlacer` (click-to-place), cross-document
  signing queues (pending-me/sent-by-me/completed), remind endpoint, in-app notifications.
- Pagination on every previously-unbounded Forms/Signing list endpoint; `min-h-0`
  scroll-containment fixes across ~9 regions; sidebar `NavParent` groups for Forms and
  E-Signing; a compact-density sidebar mode for 13-14" viewports.

### Added (2026-07-18 — Session 22: Tier-2/3 close-out)
- **PDF OCR** (`OCRWorker`): digital PDFs get exact pdfjs-dist text-layer
  extraction; image-only scans rasterize via @napi-rs/canvas into the
  tesseract pipeline (10-page cap); the accumulated `PDF_PENDING` backlog is
  requeued once at worker boot.
- **PAdES-signed flattened PDFs on e-sign completion** — fields flattened,
  certificate-of-completion page, byte-range signature via the org PKCS#12
  (`ESIGN_P12_B64`; `scripts/generate-esign-cert.js`), filed post-commit as a
  new document version. Closes the long-standing production TODO.
- `outbox_events.tenant_id` + RLS policy (migration `20260718000001`) — the
  last known RLS-latent table; the model auto-stamps the column from the
  `payload.tenantId` convention.
- **CAMS per-unit letterhead** (`org_units.letterhead_title`, migration
  `20260718000002`): sister companies issue letters under their own masthead.
- **Letters reassign-step admin UI** and **Files bulk move/tag/grant-ACL UI**
  (both backends existed, UI was deferred).
- **verify-cams.ts grown to 37 checks**: Amharic letter with embedded-font
  assertion, scanned-origin letter + cover sheet, attachment add/byte-identical
  download/remove with backing-document purge proof. 37/37 green live.
- Jest suites for the approvals engine (20) and org-units (12); suite total
  now 26 / 236.
- Deployment runbooks: `Documentations/DEPLOY-COMPOSE.md` (VPS + prod compose)
  and a manual no-Docker path.

### Removed (2026-07-18 — Session 22)
- The `/ocr` and `/archive` 501 placeholder routers (`resourceRoutes.ts`)
  — dead API surface; the real features live behind the outbox OCR channel and
  document status/retention routes.

### Added (2026-07-18 — Session 22: pre-launch hardening)
- **DR runbook** (`Documentations/DR-RUNBOOK.md`): what the compose stack
  already backs up, the off-server rclone/mc recipes each environment must
  add, KEK escrow requirements, the full restore procedure, and a restore
  drill with a sign-off table.
- **Frontend ESLint in CI** — `eslint.config.mjs` (next/core-web-vitals,
  ESLint 9 flat config), `npm --workspace frontend run lint` gated in CI; the
  10 pre-existing errors (unescaped JSX entities) fixed.
- **CI security gates**: `npm audit --omit=dev --audit-level=high` and a
  Trivy scan of the backend image (fails on fixable CRITICALs only).
- **API CSP**: deny-everything Content-Security-Policy on API responses when
  API docs are disabled (i.e. always in production).

### Fixed (2026-07-18 — Session 22: pre-launch hardening)
- **CAMS attachment removal no longer leaks storage**: `removeLetterAttachment`
  now purges the backing CORR document graph (DEK, versions, document row,
  search index entry, and — post-commit — the encrypted blob) instead of
  deleting only the `letter_attachments` row.
- `.gitattributes` forces LF for `*.sh`/Caddyfile so the volume-mounted
  deploy scripts survive Windows checkouts.

### Added (2026-07-18 — Session 22: production deployment stack)
- **`docker-compose.prod.yml`** — the first real production deployment config:
  secrets only from `.env.prod` (template: `.env.prod.example`), Caddy is the
  only published port (80/443, automatic TLS), a `migrate` one-shot runs
  `dist/scripts/migrate.js up` as the superuser before the API/worker start,
  the app connects as `edams_app` (role created by `deploy/postgres-init` on
  first boot — RLS actually enforced), MinIO bucket versioning enabled by a
  `minio-init` one-shot, nightly `pg_dump` sidecar with retention, Prometheus
  scraping the internal-only `/metrics`, Grafana under `/grafana`.
- **Internal metrics listener** — `ENABLE_PUBLIC_METRICS_ROUTE` (previously a
  dead flag) now mounts an unauthenticated `/metrics` for same-network
  scrapers; the Caddy API vhost refuses the path publicly.
- **Redis ≥ 6.2 boot check** (`assertRedisVersion`) — BullMQ's floor; hard
  error in production/staging, loud warning in dev, soft skip when Redis is
  simply unreachable.
- **More boot guards**: audit-HMAC example placeholder, `minioadmin*`
  credentials (minio driver), and localhost SMTP are all refused in
  production/staging.

### Changed (2026-07-18 — Session 22: config hygiene)
- CORS allowlist is now `CORS_ORIGINS` (comma-separated) or `CLIENT_URL` —
  the hardcoded `http://localhost:3002` dev origin no longer ships to
  production (dev/test only).
- Frontend **refuses production builds without `NEXT_PUBLIC_API_BASE_URL`**
  instead of silently hardwiring localhost (`shared/lib/apiConfig.ts`; socket
  URL now derives from the same contract). CI builds pass explicit
  placeholder build-args.
- Removed the dead `/auth/.well-known/jwks` dev stub (placeholder modulus) —
  the real JWKS at `/.well-known/jwks.json` is the only JWKS endpoint — and
  the unused `@clerk/nextjs` dependency.

### Added (2026-07-18 — Session 22: production key management + Amharic letters + boot guards)
- **Production vault backends** — the P0 "prod can't encrypt documents at all"
  contradiction is closed. `VAULT_BACKEND=dev|env|hashicorp` selects the KEK
  backend: `env` is the prod-legal env-key provider (same wrapping scheme as
  dev, master keys injected via `VAULT_MASTER_KEY[_V{n}]` secrets, emits
  `env:`-prefixed kekIds that parse interchangeably with `dev:` ones so a
  dev-seeded DB keeps decrypting); `hashicorp` is a new Transit-engine client
  (`infrastructure/vault/HashiCorpVaultService.ts`, no SDK — plain fetch;
  datakey/encrypt/decrypt/native-rewrap; `hcv:{key}` kekIds).
  `scripts/rewrap-deks.ts` is backend-aware, including the env→hashicorp
  migration (env unwrap + Transit wrap). 13 new vault tests.
- **Amharic letter PDFs** — composed letters and scanned-letter cover sheets
  now render Ethiopic script with an embedded, subset Noto Sans Ethiopic
  (`backend/assets/fonts`, OFL) instead of stripping it to `?`
  (`letterPdf.ts`); pure-Latin text keeps Helvetica. Backend Docker image now
  ships `backend/assets`. New `tests/letterPdf.test.ts`.
- **Boot guards** (`assertProductionRuntimeRequirements`, now covered by
  `tests/prodGuards.test.ts`): production/staging additionally refuse an empty
  DB password, the `postgres` superuser as the DB user (RLS bypass — same
  rules applied to an explicit `DATABASE_URL`), a missing/dev vault backend,
  a placeholder or <32-char current master key (env backend), and a missing
  `VAULT_ADDR`/`VAULT_TOKEN` (hashicorp backend).

### Fixed (2026-07-18 — Session 22: RLS loose ends + M8 sweep isolation + tus fixes)
- **M8 offboarding sweep now runs behind a savepoint** (`runInSavepoint` in
  `shared/transaction.ts`): a DB error inside the sweep previously aborted the
  whole request transaction (25P02) — the catch swallowed the JS error but the
  deactivation's own commit then failed, rolling back the security action the
  sweep must never block. Proven by fault-injection flow 8 in
  `verify-runtime-flows.ts` (statement trigger forces the sweep's first DELETE
  to raise; deactivation still commits, audit records `offboardingSweep: null`).
- **Outbox dispatcher is no longer RLS-latent**: webhook subscriber lookup and
  EMAIL recipient/attachment resolution run under `withWorkerTenantContext`
  when the payload names its tenant; `DOCUMENT.CREATED` / `HOLD_APPLIED` /
  `WORKFLOW.STARTED` producers now stamp `payload.tenantId` (+`departmentId`
  where the WEBSOCKET room needs it) so the dispatcher never needs the
  GUC-less `documents` fallback read that returns zero rows under `edams_app`.
- **OIDC-provisioned users get a real `user_tenants` membership row** (default
  tenant) instead of riding the login-time fallback forever — without it they
  were invisible to the users RLS policy inside any tenant context.
- **tus resumable uploads actually complete**: the `onUploadFinish` hook read
  `req.user` off @tus/server's srvx wrapper (always undefined → 500 at final
  PATCH); it now unwraps to the decorated node request. Upload metadata was
  also being base64-decoded a second time (mojibake → enum validation 500s).
- New verifier `test-scripts/verify-rls-tus-webhook.ts`: tus end-to-end under
  the `edams_app` rehearsal stack, tenant-scoped webhook dispatch to PROCESSED,
  and a GUC-less negative control.

### Fixed (2026-07-17 — Session 21 RLS cutover rehearsal)
- Audit-log sequence self-heal (`setval`) no longer runs inside the request
  transaction and tolerates missing privilege — under the `edams_app` role it
  failed with 42501 and poisoned every audited request, login included. New
  migration `20260717000002` also grants the role sequence UPDATE so the heal works.
- `createUser` no longer 500s under RLS (`INSERT … RETURNING` requires the new row
  to pass the SELECT policy, impossible before its `user_tenants` link exists —
  now `returning: false`) and now writes the missing `user_tenants` membership row
  for the creating tenant.
- Migration `20260717000003`: the six RLS policies with a bare
  `current_setting('app.current_tenant', true) IS NULL` fail-open arm (users,
  role_permissions, notifications, audit_logs, access_rules, acl_entries) now
  treat the empty string as unset — after any `SET LOCAL` + COMMIT the GUC reads
  back as `''` on that pooled connection, which made pre-auth paths fail
  nondeterministically under the non-superuser role.
- Document-name allocator aligns its `document_sequences` counter with names
  created outside it (seed fixtures, imports; trashed docs keep their names), so
  a freshly-seeded environment no longer 500s with a unique violation on the Nth
  upload of a dept/type/day.

### Fixed (2026-07-17 — Session 21 live-stack runtime verification)
- External e-sign actions (first view, external sign, external decline) no longer
  crash with 500: their audit writes passed `external:<email>` into the UUID
  `audit_logs.user_id` column. External identity now lives in `actionDetails`
  (pseudonymized at write) with a null userId, and the tenant is stamped explicitly
  so public-route audit rows land in the tenant's chain instead of the system chain.
- Worker bootstrap no longer logs a spurious "redis unavailable; worker bootstrap
  skipped" when the shared lazy Redis client is already connecting (it then started
  every worker anyway); it now connects only from the idle state.

### Added (2026-07-17 — Session 21)
- `backend/test-scripts/verify-runtime-flows.ts` — a 38-check live-stack verifier
  driving the seven flows that unit tests can't reach: MFA pending-token single-use,
  MFA attempt-lockout, restore-over-quota 413, trash-voids-e-sign-link, deactivation
  offboarding sweep, the AI consent gate (403 → flag → 202), and an ApprovalSlaWorker
  breach whose EMAIL outbox row reaches PROCESSED (SMTP-accepted).

### Security (2026-07-17 — Session 20 backlog + second re-audit)
- Notification fan-out no longer silently drops platform-level CRITICAL alerts
  (dead-letter / HSM) that carry a non-tenant sentinel: falls back to all admins
  when the tenant-scoped set is empty.
- Reapproval reset (new version on a PENDING_SIGNATURE/PENDING_AUDIT document) now
  voids the live signature ceremony and cancels the pending audit review, so a
  superseded version can't still be signed or audited.
- Document list / dashboard-recent now filter DOCUMENT_READ_ALL oversight roles
  through the same detail ACL (they no longer list documents the detail view 403s);
  the ACL bypass is checked against the effective permission set.
- Webhook delivery client validates literal-IP hosts before connecting (a literal
  internal IP previously bypassed the connect-time DNS guard) and supports both DNS
  lookup callback forms.

### Fixed (2026-07-17 — Session 20)
- RetentionPurgeWorker (cold-tiering, purge-cooling stages, disposal notifications)
  now sweeps per tenant under the tenant GUC — the last worker with the un-scoped
  SELECT pattern that returns zero rows under a non-superuser DB role.
- ApprovalSlaWorker isolates per-tenant failures so one tenant can't starve the rest.
- Added a Feature Flags admin panel (Operations) to toggle ai_processing and other
  per-tenant flags without a raw API call.
- Removed two notification-preference toggles that suppressed no email; corrected the
  remaining toggle's description.
- seed-reset.ts closes the DB pool and exits on both paths.
- Fixed a dead lowercase "trashed" status guard in the trash service.

### Security (2026-07-17 — Session 19 adversarial re-audit fixes)
- Webhook SSRF: closed the DNS-rebinding TOCTOU (pre-flight resolve vs. an
  independently re-resolving `fetch`). Delivery now uses a connect-time-validating
  custom DNS `lookup` with socket pooling disabled, so validation and connection
  are atomic; bracketed-IPv6 and hex-mapped-IPv4 classifier gaps also fixed.
- Cross-tenant privilege escalation: the role-grant guard now compares against a
  role's maximum permissions across ALL tenants (grants are global while
  permissions are per-tenant), so a role elevated in another tenant can't be
  laundered into a grant.
- Bulk document operations now enforce the same per-document ACL as the
  single-document routes (previously bypassed), plus destination-folder ACL on move.
- Search ILIKE fallback now filters by tenant (was cross-tenant when Meilisearch
  is unavailable).
- Admin alerts (dead-letter/virus/HSM) are scoped to the originating tenant's
  SYSTEM_ADMINs instead of every tenant's; `notifications` gained a `tenant_id`.
- MFA/TOTP: added per-account attempt limiting, single-use MFA-pending tokens, and
  step-up (current code required) before re-enrolling an existing second factor.
- SLA-breach escalation emails are no longer user-suppressible.
- Trashed documents can no longer be mutated (new-version/rollback/checkout blocked,
  locks/checkouts released on trash) and live e-sign ceremonies are voided on trash;
  concurrent trash-restore can no longer double-count storage.
- C6 list scope: document lists and dashboard-recent post-filter through the same
  `resolveACL` the detail view uses, so a list never leaks metadata for a document
  the user cannot open (list-visibility ⊆ detail-visibility).

### Fixed (2026-07-17 — Session 19)
- ApprovalSlaWorker swept with no tenant context and would have returned zero rows
  (silently stopping SLA escalation) under the intended non-superuser DB role; it
  now sweeps per tenant, batch-loads chains/documents (N+1), and guards the flag
  update on `status='PENDING'`. tus upload now sets its tenant GUC.
- M8 offboarding sweep now also releases/notifies `workflow_tasks` assignments and
  internal e-sign recipients of a deactivated user.
- `RETENTION.DISPOSAL_PENDING` webhook fan-out now resolves a tenant (was dropped).
- `archiveDocument` respects the state-machine transition graph; reapproval policy
  now applies to in-flight `PENDING_AUDIT`/`PENDING_SIGNATURE`; `updateUser` rejects
  role/department changes instead of silently ignoring them.
- `scripts/migrate.ts` now closes the DB pool and exits instead of hanging; cleared
  remaining backend lint warnings.

### Security (2026-07-16 hardening pass)
- Privilege-escalation guard: every role-grant path (assign, create-user, update)
  now rejects granting a role whose resolved permissions exceed the actor's own.
- Manual document status changes (`PATCH /documents/:id/status` + bulk) run
  against a strict `FROM->TO` permission allowlist; engine-owned transitions
  (submit/approve/sign/audit/dispose) are unreachable by hand.
- `listDocuments` and dashboard stats are ACL-scoped (owner ∪ department
  ancestry ∪ explicit ALLOW, minus DENY) instead of tenant-wide.
- `approval_steps` gained `tenant_id` + row-level security (`20260716000003`).
- Force-unlock and comment moderation require per-document ACL (both were
  tenant-wide); letter link create/delete re-gated from `letter:read` to
  `letter:create`; tus upload endpoint permission-gated; webhook subscription
  create/delete now audit-logged.
- AI consent gate: the `ai_processing` tenant feature flag now gates the AI
  chat/summarize/extract routes (403) and the AIWorker itself (fail-closed) —
  no tenant document content reaches the external AI provider without an
  explicit admin opt-in.

### Added (2026-07-16 hardening pass)
- Engine approval-step SLA sweeper (`ApprovalSlaWorker`): flags overdue PENDING
  steps once, notifies assignee/role holders + submitter in-app and by email.
- Offboarding sweep on user deactivation: releases doc locks/checkouts, and
  notifies whoever can reassign each stranded approval step, audit review, or
  letter step (`ASSIGNEE_DEACTIVATED` notification).
- Auditor reassignment endpoint for stuck PENDING audit reviews; assignable-users
  endpoint for approval pickers (no more `user:manage` requirement).
- Disposal emails: owners are emailed when a document is trashed (with the
  scheduled purge date) and when certified destruction executes (with the
  certificate reference).
- Persisted, enforced notification preferences
  (`GET/PUT /users/me/notification-prefs`, `20260716000005`) — honored by the
  outbox email dispatcher for work-reminder emails; compliance and
  external-recipient emails are never suppressible.
- 2FA login step: the login page handles `mfaRequired` with a TOTP form via
  `/auth/totp/validate` (previously an MFA-enabled user could not log in).
- DEAD_LETTER outbox events raise a CRITICAL admin notification pointing at the
  Operations retry surface; role-addressed emails reach every active holder
  (was first-created-account only).
- Regression suite `tests/remediation.hardening.test.ts` (suite count 19 → 20,
  tests 146 → 158).

### Fixed (2026-07-16 hardening pass)
- Trash-restore now atomically re-reserves storage quota (413 when it no longer
  fits) instead of blindly incrementing usage past the ceiling.
- Trashing a document cancels its live approval chain and pending audit review;
  purging removes the polymorphic engine rows (no orphans).
- E-signing: lazy expiry routes the document out of `PENDING_SIGNATURE`;
  declined ceremonies are restartable via re-send; internal recipients resolve
  to DMS accounts.
- `reapprovalPolicy` enforced on version upload and rollback; form auto-submit
  is non-fatal; duplicate resubmit races return 409.
- Latent `APPROVAL.SLA_BREACH` email gap (no recipient resolver, no template);
  chain cancellation now notifies the submitter with the reason.
- Letter archive/resolve go through `assertTransition` (state machine is the
  single source of truth); dead `incrementStorageUsed` removed; StatusBadge and
  the notifications page cover every engine/audit state and type.

### Added
- **Unified approval engine (SYSTEM-DECISIONS.md D1–D4).** New `modules/approvals`:
  admin chain templates per document type / form template with LOCKED mandatory
  steps (`approval_chain_templates`), author completion at submit (swap roles for
  named people, add/reorder unlocked steps), sequential named-person/role steps
  (`approval_chains` + `approval_steps`, generalized from letters), three
  decisions — APPROVE / REQUEST_CHANGES (chain suspends, author resubmits) /
  DECLINE (mandatory comment, revisable) — with letters-grade hardening:
  actionability validation at submit, row-lock + guarded-update concurrency,
  reassignment and admin cancel with reason. Routes under `/api/v1/approvals`.
  New permissions `approval:submit|decide|admin`; new document states
  `CHANGES_REQUESTED`, `DECLINED`. Self-service: drafters submit their own
  documents (no more `workflow:manage` gatekeeping).
- **Audit stage (D5–D7).** `PENDING_AUDIT`/`AUDITED`/`AUDIT_FLAGGED` states +
  `audit_stage_reviews`; per-type `auditPolicy (required|optional|never)`; the
  FINAL APPROVER picks a named auditor at approval; auditor PASS → archivable,
  FLAG (mandatory findings) → back to the final approver, who remediates and
  re-submits to audit; independence enforced (auditor ≠ author/approver); new
  `audit-stage:decide` permission and `AUDIT_STAGE_*` audit events.
- **Per-type signing policy (D8).** `signingPolicy (none|ceremony)` on document
  types: chain completion routes ceremony types to `PENDING_SIGNATURE`; e-sign
  completion advances `SIGNED` → `PENDING_AUDIT`/`ACTIVE`; a declined ceremony
  moves the document to `SIGNING_DECLINED`. QR/hash verification stays
  letters-only (D8b).
- **Signature images (D8c).** `PUT /users/me/signature-image` (PNG/JPEG data URL,
  ≤200 KB) rendered above the typeset name in letter signatory blocks.
- **Configurable executive notices (D10).** `PUT /tenants/:id/exec-notice-config`
  (letter types + confidentiality threshold; CONFIDENTIAL/RESTRICTED never
  auto-email by default) + per-executive opt-out (`PUT /users/me/exec-notice-opt-out`).
- **Forms through the engine (rec §7.1–7.2).** Template activation now requires
  the approval engine (direct status flips to `active` are refused; final approve
  stamps `approvedBy`); per-template `instanceApproval (none|chain)` auto-submits
  filled instances through a chain; form documents get retention clocks.
- **"My Work" unified inbox (rec §11.1).** `GET /approvals/my/work` + `/dashboard/mywork`:
  pending approval steps (documents, forms, letters), e-sign requests, audit
  reviews, and assigned incoming correspondence in one page.
- **Approval UI.** Document detail (Workflow tab): submit-for-approval modal with
  template pre-fill and locked steps, chain stepper (done/hot/future, names +
  emails + current role holders), Approve / Request changes / Decline with
  auditor pick on final approve, auditor PASS/FLAG, re-submit to audit. Document
  lists show the D4 progress hint ("2/3 · waiting on X") next to the IN_REVIEW chip.
- **Admin/self-service UI for every new backend knob** (no more API-only
  configuration): Document Types dialog gains the three governance policy
  selects (+ a Governance column); new Operations → **Approval Chains** panel
  (chain-template editor with locked steps/SLA + the audit-stage register);
  Settings → **Profile & Signature** (handwritten-signature upload, executive
  notice opt-out); Tenants panel ✉ action edits the executive-notice policy;
  form builder gains the "filled instances require approval" toggle and the
  forms list submits templates through the engine (status-flip Approve button
  replaced); Recycle Bin gains **Cancel destruction**; the approval chain card
  gains admin **Reassign** (stuck steps) and **Cancel chain**.

### Fixed
- **SSO login broke completely whenever Redis was down.** `GET /auth/oidc/authorize`
  and `POST /auth/callback` stored/verified the CSRF `state`/`nonce` pair only in
  Redis, and `/callback` deliberately failed closed (503) if Redis was unreachable.
  In practice this meant clicking through from the IdP portal hit `:4000`, crashed
  with a 500 before it could redirect onward to `:3000`, and SSO was unusable
  without Redis running. Added `oidc_state_nonces` (migration
  `20260714000001-oidc-state-nonces.sql`) as a Postgres fallback: `storeOidcState`/
  `consumeOidcState` (`modules/auth/auth.routes.ts`) now use Redis when reachable
  and fall back to Postgres otherwise, keeping the same CSRF guarantee either way.

## [1.0.0] - 2026-07-13

First tracked release. Establishes the versioning/rollout process itself
(see `Documentations/rollout.md`) alongside a round of CAMS correspondence features.

### Added
- CAMS: outgoing letters can now be filed as a scan of a signed paper
  original (`POST /letters/scanned`), not just composed in-system — goes
  through the same draft → review → approval chain either way.
- CAMS: incoming and outgoing scans now accept Word (.doc/.docx) in addition
  to PDF and images.
- CAMS: any scanned-origin letter gets a generated one-page QR verification
  cover sheet, since a QR can't be stamped onto an externally-produced file
  the way it's baked into a system-rendered PDF.
- CAMS: composed letters can carry supplementary attachments while still a
  draft (add/download/remove), independent of the letter's main body.
- CAMS: a new `EXECUTIVE` role gets emailed (with the letter attached) when
  any letter reaches a final state (approved / registered) — standing
  correspondence oversight, tenant-wide.
- CAMS: dispatching a letter over the `EMAIL` channel now actually emails
  the recipient (letter + cover sheet attached) via a dedicated BullMQ queue
  with its own retry/backoff, when a recipient address is on file.
- CAMS: a "print cover sheet" action for when a letter needs to go out on
  paper (no email on file, or the recipient doesn't accept digital).
- Letters gained a `correspondentEmail` field (the actual send-to address,
  distinct from the display name fields).
- A real per-migration rollback mechanism: a migration `NNNN-name.sql` can
  now ship a sibling `NNNN-name.down.sql` that `db:migrate:down` actually
  runs — previously `down` was hardcoded to refuse for every migration.
- A migration safety check (`db:migrate:check`, wired into CI) that flags
  destructive-looking new migrations (dropping/renaming/adding a `NOT NULL`
  without a backfill) unless justified with a `-- SAFE:` comment.
- A per-tenant feature-flag service (`modules/feature-flags/`) — ship code
  dark, turn behavior on per-tenant without a redeploy.
- `backend/Dockerfile` and `frontend/Dockerfile` — the prod-shaped
  `docker-compose.yml` referenced these but they didn't exist yet.
- CI now builds both Docker images on every push/PR and pushes tagged
  images to GHCR on merges to `main`.

### Fixed
- **Redis outage handling was broken almost everywhere.** Token revocation
  checks (on every authenticated request), rate limiting, and several
  caches (roles, ACL, feature flags, department lookups, audit chain) all
  shared one Redis connection configured with infinite retry patience
  (a real requirement for the BullMQ queues that also use it) — so when
  Redis was unreachable, those checks hung indefinitely instead of falling
  back the way their code clearly intended. Split into two connections: the
  original patient one stays reserved for BullMQ; everything else now uses
  a fail-fast connection, so a Redis outage degrades (rate limiting off,
  caches bypassed, revocation checks fail open with a logged warning)
  instead of hanging every request.
- The Redis-backed rate limiter had no fallback at all when Redis errored —
  it let the error propagate and 500'd the request. It now fails open
  (doesn't rate-limit that request) instead of failing the request itself.
- Frontend: the API base URL fallback was hand-copied into 7 different
  files; consolidated into one exported constant (`shared/lib/apiConfig.ts`).

### Changed
- `backend/package.json` and `frontend/package.json` versions bumped from
  the placeholder `0.1.0` to `1.0.0`.
