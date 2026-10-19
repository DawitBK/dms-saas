// SPRINT-1/6: add and guard JWT mock/external verifier settings plus production-only safety checks.
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// ---------------------------------------------------------------------------
// ENV FILE LOADING CONTRACT — identical in GMS, SSO and DMS. Change all three
// together or not at all.
//
//   NODE_ENV=production   ->  .env.production ONLY. `.env` is NEVER read.
//   anything else         ->  .env ONLY.
//
// Production is deliberately ISOLATED rather than layered. Layering the dev
// `.env` underneath `.env.production` looks harmless and is not, because
// dotenv only overrides the keys the layering file actually NAMES: every key
// `.env.production` happens not to mention silently keeps its DEVELOPER value
// in production. That is not hypothetical — measured on 2026-09-05, a
// production launch of DMS inherited a personal Gmail address in
// EMAIL_REDIRECT_TO (which silently diverts every notification, approval and
// dispatched letter), dev MinIO credentials, and no STORAGE_LOCAL_PATH.
//
// Worse, `.env`'s own first line is NODE_ENV=development. Loaded with
// override:true it clobbered the launcher's NODE_ENV=production, so the
// production layer never fired at all AND every check in
// assertProductionRuntimeRequirements() below returned early — DMS booted on
// the DEV database, with no error, looking healthy.
//
// GMS never had either fault because it already loaded only .env.production in
// production (backend/src/config/index.ts). This is that rule, adopted here and
// in SSO on 2026-09-05 so all three systems now behave the same way.
//
// NODE_ENV is read from the real process environment BEFORE any file is
// loaded, so no env file can influence which env file gets loaded. The `*:prod`
// npm scripts set it via scripts/run-with-env.cjs rather than shell-specific
// syntax, so this works identically on Windows and POSIX.
// ---------------------------------------------------------------------------
const externalNodeEnv = process.env.NODE_ENV;

if (externalNodeEnv === "production") {
  const productionEnvPath = path.resolve(process.cwd(), ".env.production");
  if (!fs.existsSync(productionEnvPath)) {
    // dotenv is a SILENT no-op on a missing file. Without this check, a
    // production boot with no .env.production would fall through to schema
    // defaults — postgres@localhost/edams with an empty password — and fail
    // later with a message describing a symptom instead of the cause. The
    // guards below would eventually catch it, but "A database password is
    // required" sends you to look at the wrong thing.
    throw new Error(
      `NODE_ENV=production but ${productionEnvPath} does not exist.\n` +
        "Production configuration is read from .env.production ONLY — `.env` is the development " +
        "file and is deliberately not read in production.\n" +
        ".env.production is gitignored (it holds real secrets) so it is never part of a clone or a " +
        "file copy: it has to be placed on this machine by hand. See MANUAL-TRANSFER-TO-SERVER.md.",
    );
  }
  // override:true so this file wins over any ambient machine-wide variable —
  // e.g. a leftover Railway/Render DATABASE_URL (root CLAUDE.md, "Known footguns").
  loadDotenv({ path: productionEnvPath, override: true, quiet: true });
  // .env.production sets NODE_ENV=production itself; pin it anyway so the file
  // and the launcher can never disagree about which mode this process is in.
  process.env.NODE_ENV = "production";
} else if (externalNodeEnv === "mirror") {
  // A genuinely separate third environment — a local production-parity
  // "mirror" for verifying prod-shaped behavior (assertProductionRuntimeRequirements
  // already treats "mirror" identically to production, see below) against its
  // own database/ports/secrets, without touching the real dev `.env`/
  // `.env.development` or the real `.env.production`. Same isolation contract
  // as production: this file ONLY, never layered under any other env file.
  const mirrorEnvPath = path.resolve(process.cwd(), ".env.mirror");
  if (!fs.existsSync(mirrorEnvPath)) {
    throw new Error(
      `NODE_ENV=mirror but ${mirrorEnvPath} does not exist.\n` +
        "Mirror configuration is read from .env.mirror ONLY — `.env`/`.env.development` is the " +
        "development file and `.env.production` is the real production file; neither is read here.",
    );
  }
  loadDotenv({ path: mirrorEnvPath, override: true, quiet: true });
  process.env.NODE_ENV = "mirror";
} else {
  // Prefer .env.development when present (the file this loop writes going
  // forward); fall back to the historical bare `.env` so an existing
  // checkout that has never been touched keeps working unchanged.
  const developmentEnvPath = path.resolve(process.cwd(), ".env.development");
  const devEnvPath = fs.existsSync(developmentEnvPath) ? developmentEnvPath : path.resolve(process.cwd(), ".env");
  loadDotenv({ path: devEnvPath, override: true, quiet: true });
  // `.env` sets NODE_ENV=development on its first line. Under override:true
  // that silently rewrites an explicit NODE_ENV=test from the launcher, which
  // would point the Jest suite at the development database.
  if (externalNodeEnv) {
    process.env.NODE_ENV = externalNodeEnv;
  }
}

const boolFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => value === true || value === "true");

// Compose/orchestrators interpolate unset variables to "" — treat that as
// unset for optional fields (an empty string must not fail .url() or count
// as a configured value).
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

/**
 * P2-9 item 19: duration strings are validated HERE, at boot, so the parsers that
 * consume them can stop guessing.
 *
 * auth.routes.ts's parseDurationMs() silently returned 8h on any string it could
 * not parse, and GMS's equivalent silently returned 7d. Both feed a cookie
 * `maxAge` or a DB expiry while the JWT's own `exp` is computed by jsonwebtoken
 * from the SAME string — so a typo did not fail, it produced a cookie and a token
 * that disagreed about when the session ends, which surfaces later as
 * "randomly logged out" or "token still accepted after the cookie went away".
 * Rejecting the value at boot is the only place that can be fixed once.
 */
const durationString = (fallback: string) =>
  z.string().default(fallback).refine((v) => /^\d+(ms|s|m|h|d)$/.test(v), {
    message: 'must be a duration like 15m, 8h or 30d (number followed by ms|s|m|h|d)',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "mirror", "production"]).default("development"),
  AUDIT_HMAC_SECRET: z.string().min(32),
  /**
   * How many independent hash chains each tenant's audit trail is split
   * across (R-02, Documentations/audits/AUDIT-FINDINGS-2026-09-03.md).
   *
   * writeAuditLog holds a per-tenant advisory XACT lock from a request's
   * first audit write until that request's transaction commits — which is at
   * response-finish time — so with one chain per tenant, every mutating
   * request in a tenant queues behind the one in front of it. That lock is
   * not incidental: the chain tip is read from committed state under it, so
   * it is what stops a writer reading a stale tip and durably committing a
   * row that skips the real last entry.
   *
   * Sharding raises the concurrency ceiling without touching that guarantee:
   * the lock is taken per (tenant, shard), so N shards admit N concurrent
   * audited writers per tenant while every audit row still commits
   * atomically with the change it records.
   *
   * Safe to change at any time — shards are assigned randomly per write, not
   * derived from row content, so existing rows keep the chain they are in and
   * only the distribution of new rows changes. 1 reproduces the old
   * single-chain behaviour exactly.
   */
  AUDIT_CHAIN_SHARDS: z.coerce.number().int().min(1).max(64).default(8),
  PORT: z.coerce.number().default(7100),
  /** Per-user request budget for the authenticated v1 API, per minute.
   *
   *  Raised from 100 (2026-09-23): a single admin working one Operations page
   *  (five Access-Control tabs, notification/approval polling every ~10s)
   *  tripped this on its own — "Too many requests, please slow down" on
   *  completely normal single-user usage, not abuse. This limiter and
   *  admission control (api/v1/index.ts) protect different things: this caps
   *  one caller's request RATE over a minute; admission control separately
   *  caps concurrent IN-FLIGHT requests against the DB pool regardless of
   *  this value, so raising this does not let one user starve everyone
   *  else's connections. Sized generously enough to never bother a real user
   *  or a legitimate heavy-polling UI, while still stopping a genuinely
   *  runaway/bot client (thousands of req/min from one identity). */
  RATE_LIMIT_USER_PER_MINUTE: z.coerce.number().int().positive().default(1000),
  // Loopback by default, per DEPLOYMENT-GUIDE.md's C5 pre-deploy check ("All 4
  // API ports loopback-only: 7100/7200/7300/7400 … Nothing on 0.0.0.0") and
  // SERVER-INFRASTRUCTURE-AUDIT.md §2 (Apache on 80/443 is the only sanctioned
  // public entry point). Was "0.0.0.0", which exposed 7100 on every interface
  // and made C5 impossible to satisfy without setting HOST by hand on the box.
  HOST: z.string().default("127.0.0.1"),
  API_BASE_PATH: z.string().default("/api/v1"),
  /**
   * How many reverse-proxy hops in front of this process are trusted to set
   * `X-Forwarded-For` — passed straight to Express's `trust proxy` setting.
   *
   * This is NOT cosmetic. Express defaults `trust proxy` to FALSE, and in
   * production every request reaches DMS through the shared Apache reverse
   * proxy over loopback (DEPLOYMENT-GUIDE.md C5 — 7100 is loopback-only), so
   * with that default `req.ip` was Apache's own address for EVERY user in the
   * organisation. Three things silently keyed off that single collapsed value:
   *
   *   - The IP rate limiters in app.ts. `/api/v1/auth` allows 20 req/min and
   *     `/api` allows 800 req/min PER IP — collapsed to one IP that is 20
   *     logins per minute and ~13 req/s for the whole company. At real
   *     concurrent load that is a self-inflicted outage, and it presents as a
   *     mysterious 429 storm rather than as a misconfiguration.
   *   - `audit_logs.source_ip`: the forensic record of who acted from where
   *     recorded the proxy on every single event.
   *   - The AUTHN_FAILURE audit sampler (shared/auth.ts), which buckets by
   *     source IP. One bucket for everyone means 3 rows/min total across the
   *     whole estate, which hides a real credential-stuffing burst.
   *
   * Default `loopback`: trust `X-Forwarded-For` only when the immediate peer
   * is 127.0.0.1/::1 — exactly the Apache hop — and ignore the header from
   * anywhere else, so a client cannot forge its own address. Never set this to
   * `true` (trust every hop): that hands `req.ip` to the caller and lets any
   * client bypass every per-IP limit above just by rotating a header.
   *
   * Accepts anything Express accepts: `loopback` / `false` / a hop count /
   * a comma-separated address-or-CIDR list.
   */
  TRUST_PROXY: z.string().default("loopback"),

  /**
   * The path prefix this system is served under on the SHARED public origin
   * (P1-11). All four systems live on portal.examplecorp.com separated by path
   * only, so a cookie with `Path=/` is sent to GMS's, SSO's and MRS's backends
   * on every request they receive. DMS's refresh token is a bearer credential
   * and has no business crossing into a sibling system's request logs or a
   * sibling system's compromise.
   *
   * Empty in dev (single-origin localhost, nothing to isolate from). Set to
   * `/dms` in production. Note this is the BROWSER-visible prefix, which is not
   * the same as API_BASE_PATH — Apache strips `/dms` before proxying, so the app
   * never sees it in req.path and cannot infer it.
   */
  PUBLIC_BASE_PATH: z.string().default(""),
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().default(5432),
  DB_USER: z.string().default("postgres"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("edams"),
  // scripts/migrate.ts only — never read by the app itself (main.ts/worker.ts
  // never call anything that touches this). Real production (docker-compose.prod.yml)
  // deliberately runs its `migrate` one-shot as the postgres superuser and only
  // the API/worker connect as the least-privilege DB_USER/edams_app (see
  // Documentations/DEPLOY-COMPOSE.md: "migrate one-shot applies all migrations
  // as the superuser -> API + worker boot as edams_app"). A local (non-Docker)
  // mirror or manual production setup has no such service-level separation —
  // DB_USER alone runs both the app AND, via `npm run db:migrate[:mirror|:prod]`,
  // the migrations — so if that role doesn't already own every table, any
  // migration that ALTERs an existing table fails with "must be owner of table
  // X" (hit 2026-09-21 setting up a fresh local mirror). Set these to a
  // superuser credential to give migrate.ts its own connection, matching the
  // Docker split, without touching DB_USER/DB_PASSWORD (the app's own runtime
  // credential, which assertProductionRuntimeRequirements() above still
  // correctly refuses to let be "postgres"). Falls back to DB_USER/DB_PASSWORD
  // when unset, so this is a no-op everywhere DB_USER is already postgres
  // (dev, and any environment where the two match).
  DB_MIGRATE_USER: z.string().optional(),
  DB_MIGRATE_PASSWORD: z.string().optional(),
  // Perf audit 2026-08-13: tenantContext (shared/middleware.ts) holds one
  // pooled connection for the FULL request lifetime (needed for RLS's
  // per-transaction SET LOCAL app.current_tenant, not incidental — see that
  // file's comments), so this pool size is the real ceiling on concurrent
  // authenticated requests, not just a DB-load knob. Bumped from 20; the
  // shared Postgres instance's max_connections is 100 across GMS/DMS/SSO/MRS,
  // so this still leaves headroom (verified against live pg_stat_activity).
  /**
   * R-01 (Documentations/audits/AUDIT-FINDINGS-2026-09-03.md): this is the real ceiling on
   * concurrent authenticated requests, because `tenantContext`
   * (shared/middleware.ts) holds one pooled connection for the FULL lifetime
   * of every authenticated request — the transaction is committed only once
   * the HTTP response completes. That is deliberate, not incidental: it is
   * what makes RLS's per-transaction `SET LOCAL app.current_tenant` work at
   * all, since a bare query outside a transaction cannot carry it.
   *
   * CORRECTION to that register's own recommendation, which said PgBouncer in
   * transaction pooling mode would lift this. It will not, and the reasoning
   * there was incomplete. Transaction pooling releases a server connection at
   * COMMIT — but DMS's transaction spans the whole request, so PgBouncer
   * would hold a server connection for the whole request too, and transaction
   * pooling degenerates to session pooling in terms of hold time. What
   * PgBouncer does buy is real but different: it decouples client from server
   * connections, so the API process, the BullMQ worker and any future second
   * instance share ONE server-connection budget instead of each reserving
   * DB_POOL_MAX, and overflow queues in a tunable place instead of failing on
   * DB_POOL_ACQUIRE_MS. It is offered as an opt-in compose profile.
   *
   * So the effective concurrency limit is:
   *
   *   requests/sec  ~=  DB_POOL_MAX / average request duration
   *
   * which means request DURATION is as much the lever as pool size. Today the
   * request transaction is held across genuinely slow non-DB I/O — ClamAV
   * scans, PDF rendering, MinIO round-trips (letters.service.ts calls
   * scanBuffer, generateLetterPdf and encryptAndStore while the request
   * transaction is open; moving them out of an inner runInTransaction block
   * does NOT help, because the outer request transaction still holds the
   * connection). The structural fix is to stop spanning that work, and it is
   * a design change, not a setting: see the R-01 entry in the audit register.
   *
   * Raised 30 -> 60 here as the direct, immediate lever. Pair it with
   * max_connections on the shared Postgres instance, which serves
   * GMS/DMS/SSO/MRS from one budget — docker-compose.prod.yml raises it to
   * 300 alongside this. 60 connections is a trivial memory cost to Postgres
   * (~10MB of backend overhead) next to a 500 on the 31st concurrent request.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(60),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_POOL_ACQUIRE_MS: z.coerce.number().int().positive().default(30000),
  DB_POOL_IDLE_MS: z.coerce.number().int().positive().default(10000),

  /**
   * R-01 load safety: bounds on how long a single request may hold the pooled
   * connection it checks out. Applied as `SET LOCAL` inside the per-request
   * transaction that tenantContext opens (shared/middleware.ts), NOT as a
   * connection-level default — deliberately, because the same Sequelize
   * instance is used by the Umzug migration runner (scripts/migrate.ts), the
   * BullMQ workers and the one-off backfill scripts, and a 30s cap would
   * abort a legitimate long `CREATE INDEX` or a multi-minute backfill. Being
   * transaction-scoped, they also reset automatically when the request
   * commits or rolls back, so nothing leaks onto the pooled connection.
   *
   * Why these matter more than the pool size: the pool is only a ceiling if
   * connections come BACK. Without a bound, a single request wedged on a
   * query — a lock it will never win, a peer that stopped reading — holds its
   * connection until the process restarts. Enough of those and the pool is
   * permanently gone, which presents as total unavailability rather than as
   * slowness, and no amount of DB_POOL_MAX helps.
   *
   * STATEMENT: caps any ONE statement, lock waits included (a statement
   * blocked on a lock counts toward it), so this is also what stops the audit
   * chain's advisory-lock waits from becoming unbounded.
   *
   * IDLE_IN_TRANSACTION: caps a transaction sitting open with no statement
   * running. Deliberately much larger than the statement cap, because the
   * request transaction is legitimately idle while the handler awaits
   * non-DB I/O — a ClamAV scan, PDF rendering, a MinIO round-trip (see the
   * DB_POOL_MAX note below). This must stay comfortably above the slowest of
   * those or it will abort healthy uploads; it exists to reclaim a connection
   * from a handler that has genuinely stopped making progress, not to
   * discipline slow I/O.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(120_000),

  /**
   * R-01 admission control: the maximum number of authenticated requests
   * allowed to be in flight (holding, or queued for, a tenant-scoped
   * transaction) before further requests are shed with a 503.
   *
   * Without a bound, overload does the worst possible thing. Every request
   * past DB_POOL_MAX queues inside the pool for up to DB_POOL_ACQUIRE_MS
   * (30s), holding a socket, a parsed body and its whole async context the
   * entire time — so a burst converts into thousands of requests all waiting
   * half a minute to be told no, memory climbing the whole way, and clients
   * that have long since timed out and retried, adding more. That is how a
   * slow period becomes an outage.
   *
   * Shedding instead turns the same burst into an immediate, cheap 503 with
   * `Retry-After`, which sheds work the client can retry rather than
   * accepting work the process cannot finish. Serving 200s at capacity and
   * 503s past it is strictly better than serving timeouts to everyone.
   *
   * 0 means "derive it": DB_POOL_MAX * 2, i.e. allow roughly one request
   * queued per connection before refusing. Set explicitly to override.
   */
  REQUEST_ADMISSION_MAX: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().optional(),
  // Belt-and-suspenders alongside override:true above: that fix only helps
  // when THIS app's own .env/.env.production actually defines DATABASE_URL
  // (they don't — DMS is configured via DB_HOST/DB_USER/DB_PASSWORD/DB_NAME,
  // see .env.example), so it can't override a stray machine-wide
  // DATABASE_URL that was never in either file to begin with. A leftover
  // Railway/Render DATABASE_URL from an unrelated project can carry a
  // perfectly valid-looking non-superuser password, which is all
  // assertProductionRuntimeRequirements below checks — it has no way to
  // tell "this is real prod config" apart from "this happens to parse".
  // Requiring this separate, explicit flag means an ambient DATABASE_URL is
  // ignored (falls back to the DB_* parts) unless someone deliberately
  // opts in — a one-time step for hosts (Railway/Render/Heroku-style) that
  // legitimately inject DATABASE_URL as their real config.
  DATABASE_URL_TRUSTED: boolFromString.default(false),
  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: durationString("15m"),
  // CAMS: base URL encoded into letter QR codes (public verification page)
  CAMS_VERIFY_BASE_URL: z.string().default("http://localhost:7101/verify"),
  // Shared secret for the IdP's internal role/permission-override admin API
  // (shared/internalAuth.ts) — unset means those routes always refuse.
  DMS_INTERNAL_API_KEY: optionalString,

  /**
   * P1-10: comma-separated source addresses allowed to reach the internal admin
   * API at all, checked BEFORE the shared secret is compared.
   *
   * That API is gated by a single static key and, on success, synthesizes a
   * SYSTEM_ADMIN principal holding every DMS permission on whatever tenant the
   * caller names. Every real caller is the SSO backend on the same host
   * (DEPLOYMENT-GUIDE.md: DMS_API_BASE_URL=http://127.0.0.1:7100/api/v1), so
   * loopback-only costs nothing and removes the remote attack surface — including
   * the ability to brute-force the key at network speed — entirely.
   *
   * `*` disables the check. Do not use it in production.
   */
  INTERNAL_API_ALLOWED_IPS: z.string().default("127.0.0.1,::1,::ffff:127.0.0.1"),
  JWT_REFRESH_EXPIRES_IN: durationString("8h"),
  LOCAL_JWT_MOCK: boolFromString.default(false),
  // Unset (not defaulted) so every jwt.sign() call's `DEV_JWT_ISSUER ??
  // AUTH_ISSUER` fallback actually falls through to the real production
  // issuer/audience when these dev-only overrides aren't configured.
  DEV_JWT_ISSUER: optionalUrl,
  DEV_JWT_AUDIENCE: optionalString,
  AUTH_ISSUER: process.env.NODE_ENV === 'production'
    ? z.string().min(1)
    : z.string().optional(),
  AUTH_AUDIENCE: process.env.NODE_ENV === 'production'
    ? z.string().min(1)
    : z.string().optional(),
  AUTH_JWKS_URI: z.string().optional(),
  // OIDC / SSO (optional Ã¢â‚¬â€ omit to disable SSO login flow)
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  /**
   * Must include `edams_roles` and `ad_groups` (SSO P1-2): those claims moved out
   * of the `profile` scope into their own, so a request for only
   * `openid profile email` now returns an id_token with no roles and no groups.
   * The callback would then fall through to local user_roles and, for a
   * first-time SSO user with no rows, to ['EMPLOYEE'] — the same silent
   * role-flattening the reverted `edams`→`dms` rename caused (root CLAUDE.md).
   * Keep in step with SSO's clientSeed scope for client_id 'edams'.
   */
  OIDC_SCOPES: z.string().default('openid profile email ad_groups edams_roles'),
  // Explicit token endpoint; falls back to AUTH_ISSUER + /token when omitted
  OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
  DEV_RSA_PRIVATE_KEY: z.string().optional(),
  DEV_RSA_PUBLIC_KEY: z.string().optional(),
  SEARCH_ENGINE: z.enum(["postgres", "meilisearch"]).default("postgres"),
  REDIS_URL: z.string().optional(),
  MINIO_ENDPOINT: z.string().default("localhost"),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: boolFromString.default(false),
  // Required only when STORAGE_DRIVER=minio — enforced in the superRefine below
  // rather than here, so the requirement matches the invariant that actually
  // exists.
  //
  // These were `z.string().min(1)`, i.e. mandatory for EVERY deployment. That
  // was wrong and it was a production boot-blocker: this server runs DMS
  // natively with STORAGE_DRIVER=local and no MinIO at all (see
  // production-start.bat), so `.env.production` correctly does not define them
  // — and DMS therefore could not start from `.env.production` alone. It only
  // appeared to work on a developer machine because the dev `.env`, which
  // production no longer reads, happened to supply them.
  //
  // Kept as `.default("")` rather than `.optional()` so the exported type stays
  // `string` and the MinIO client construction sites
  // (infrastructure/storage/minio.ts, storage/index.ts) need no change.
  MINIO_ACCESS_KEY: z.string().default(""),
  MINIO_SECRET_KEY: z.string().default(""),
  MINIO_BUCKET_DOCUMENTS: z.string().default("dms-documents"),
  MINIO_BUCKET_ARCHIVE: z.string().default("dms-archive"),
  MEILISEARCH_HOST: z.string().url().optional(),
  MEILISEARCH_MASTER_KEY: z.string().optional(),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: boolFromString.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default("DMS System <noreply@edams.local>"),
  // Non-production safety valve. When set, every outbound email goes to this
  // address instead of its real recipients (the intended ones are preserved in
  // the subject and body so a test still shows who would have been mailed).
  //
  // This exists because testing email in dev means pointing SMTP_* at the real
  // Gmail relay -- the same account and app password production uses -- and the
  // dev database is full of seeded users at @edams.local plus real colleagues'
  // addresses. Without a redirect, one `npm run dev` that drains a backlog
  // sends thousands of messages from systems@examplecorp.com to addresses that
  // do not exist, which is how a relay account gets rate-limited or suspended.
  // Refused outright in production/mirror below.
  // Preprocessed like the other optional fields so an explicitly-blank
  // `EMAIL_REDIRECT_TO=` counts as unset rather than failing .email(). That
  // matters because dotenv's override only replaces keys the layering file
  // actually defines: without a blank line for it in .env.production, this
  // dev-only value survives from .env into production and trips the boot
  // guard below. Same idiom already used for DEV_JWT_ISSUER/DEV_JWT_AUDIENCE.
  EMAIL_REDIRECT_TO: z.preprocess(emptyToUndefined, z.string().email().optional()),

  /**
   * Admin alerting for unhandled server faults (shared/middleware.ts's
   * ERR-INTERNAL catch-all). Before this existed, the 500 response's own text
   * — "The team has been notified" — was not backed by anything: the only
   * side effect was a line in the local pino log file, which nobody reads
   * without deliberately opening it. Both channels below are independently
   * optional; whichever is configured actually fires, and the /operations
   * "System Errors" panel exposes which ones are wired so this can be
   * verified from the UI instead of taken on faith.
   *
   * ADMIN_ALERT_WEBHOOK_URL: a Slack incoming-webhook URL. Point it at the
   * SAME webhook the platform's uptime-monitor.ps1 posts to
   * (EXAMPLECORP_ALERT_WEBHOOK in that script) so outage alerts and
   * application-fault alerts land in one channel instead of two.
   */
  ADMIN_ALERT_WEBHOOK_URL: optionalUrl,
  // Comma-separated admin recipient list for the same alert, sent via the
  // existing mailer (infrastructure/email/mailer.ts) — a direct send, not
  // routed through the transactional outbox, since the outbox needs a DB
  // transaction and a DB-capacity fault is exactly one of the things this is
  // meant to alert on.
  ADMIN_ALERT_EMAIL_TO: optionalString,
  // Dedupe window per (route + error type) fingerprint, so one flapping bug
  // sends one alert per window instead of one per request — the same
  // state-change-only philosophy uptime-monitor.ps1 already uses for
  // up/down transitions. The in-app panel still shows every occurrence's
  // count regardless of throttling.
  ADMIN_ALERT_THROTTLE_MS: z.coerce.number().int().positive().default(600_000),
  CLAMAV_HOST: z.string().default("localhost"),
  CLAMAV_PORT: z.coerce.number().default(3310),
  CLAMAV_ENABLED: boolFromString.default(false),
  // true = when the scanner is enabled but cannot be reached, REFUSE the upload (503 ERR-AV-UNAVAILABLE) instead of accepting it
  // as 'unscanned'. Default false keeps the documented fail-open policy; turn it on once clamd is monitored and an outage of
  // uploads is an acceptable price for never storing an unscanned file.
  CLAMAV_FAIL_CLOSED: boolFromString.default(false),
  // How long an undelivered EMAIL outbox event stays deliverable. Generous by
  // design — "an approval is waiting for you" is still true tomorrow — so this
  // is a bound on a flood, not a suppressor of genuine mail. See
  // CHANNEL_MAX_AGE_HOURS in infrastructure/queue/outbox.ts for why WEBSOCKET
  // is far shorter and why OCR/SEARCH_INDEX never expire at all.
  OUTBOX_EMAIL_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  // Unified approval engine: step delegation and automatic escalation of overdue steps
  // (modules/approvals/escalation.service.ts, the single place these are read).
  // Escalation adds the overdue step's department head(s), else approval admins, as
  // co-deciders; it never removes the assignee. Turn either off here, no code change.
  APPROVAL_DELEGATION_ENABLED: boolFromString.default(true),
  APPROVAL_ESCALATION_ENABLED: boolFromString.default(true),
  // Hours between the SLA breach flag and the escalation (0 = escalate on the same sweep).
  APPROVAL_ESCALATION_GRACE_HOURS: z.coerce.number().min(0).max(24 * 30).default(24),
  // Most people one escalation may add as co-deciders.
  APPROVAL_ESCALATION_MAX_TARGETS: z.coerce.number().int().min(1).max(10).default(3),
  // Letters: a step's deadline in hours when the drafter does not choose one at submit time (0 = no deadline,
  // the behaviour before 2026-10-10). Breach flagging and escalation of letter steps reuse the
  // APPROVAL_ESCALATION_* switches above, so one policy governs both engines.
  LETTER_STEP_DEFAULT_SLA_HOURS: z.coerce.number().int().min(0).max(24 * 90).default(0),
  // Platform licensing (docs/operations/PLATFORM-LICENSING.md at the repo root; DMS is system key `dms`).
  // The licence is issued in SSO and checked here from a signed token. None of these is required: with no
  // licence record in SSO, or with SSO unreachable and no token ever fetched, nothing is enforced.
  //   enforce - read-only on expiry, module gate, seat limit (default)
  //   warn    - states are computed and shown (banner, /license/status) but nothing is ever blocked
  //   off     - no fetcher, no enforcement; /license/status answers `unknown`
  // Emergency switch: LICENSE_ENFORCEMENT=warn and restart the API.
  LICENSE_ENFORCEMENT: z.preprocess(emptyToUndefined, z.enum(["enforce", "warn", "off"]).default("enforce")),
  // Base URL of the SSO BACKEND (no path). The token route is a single constant in
  // modules/license/license.constants.ts. The mirror's env sets http://127.0.0.1:9300.
  LICENSE_SSO_URL: z.preprocess(emptyToUndefined, z.string().url().default("http://127.0.0.1:7300")),
  // Seconds between licence polls (first poll at boot). Floor 10 so a typo cannot hammer SSO.
  LICENSE_POLL_SECONDS: z.coerce.number().int().min(10).max(86_400).default(300),
  // Where the last verified token is kept so a restart while SSO is down still enforces it. Unset =
  // <cwd>/.license/dms-<NODE_ENV>.json (git-ignored; one file per environment because dev and mirror
  // run out of the same checkout).
  LICENSE_CACHE_PATH: optionalString,
  // Per-application ENTITLEMENT (contract section 9): whether this system may be used at all. Default true when
  // NODE_ENV is production or mirror (the live server and the prod-parity mirror), false otherwise, so development
  // and tests behave exactly as before. When true and no verified licence is held, every request except sign-in,
  // health and the licence routes answers 403 LICENSE_REQUIRED. `false` in a production process is logged at
  // error level at every start (startLicensePolling).
  LICENSE_REQUIRED: z.preprocess(
    (v) => (v === "" || v === undefined ? process.env.NODE_ENV === "production" || process.env.NODE_ENV === "mirror" : v),
    boolFromString,
  ),
  // JSON array of PUBLIC RS256 JWKs allowed to sign a licence. When LICENSE_REQUIRED is true these are the ONLY keys
  // that verify one (SSO's JWKS is not trusted for licences); when it is false they are used if set, otherwise the
  // SSO JWKS as before. Kept as the raw string: parsed (and a bad value reported) in modules/license/license.service.ts.
  LICENSE_TRUST_PUBLIC_KEYS: optionalString,
  ENABLE_QUEUE_WORKERS: boolFromString.default(true),
  ENABLE_OUTBOX_POLLING: boolFromString.default(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  ENABLE_API_DOCS: boolFromString.default(true),
  ENABLE_PUBLIC_METRICS_ROUTE: boolFromString.default(false),
  STORAGE_DRIVER: z.enum(["local", "minio"]).default("local"),
  // Absolute path to the local document store. Defaults to
  // <cwd>/storage/dms-documents, which is what this was hardcoded to.
  //
  // Two reasons it has to be configurable rather than derived from cwd:
  //
  //   1. cwd is set by whoever launches the process. A .bat that starts the
  //      backend from anywhere other than the backend directory silently
  //      creates a NEW, empty document store and every existing document 404s
  //      — with no error at boot, because an empty directory is a valid one.
  //   2. The store outgrows the system drive long before the database does.
  //      Pointing it at a second disk (or a mounted external drive) has to be
  //      a config change, not a code change or a filesystem junction, or
  //      nobody will do it safely under pressure.
  //
  // Changing this does NOT move existing files. Copy the directory across
  // first, verify, then repoint — storage keys are relative to this root, so
  // the contents are portable but the location is not automatic.
  STORAGE_LOCAL_PATH: z.string().optional(),
  // Which key-management backend wraps document DEKs:
  //   dev       — env-key derivation, dev/test only (blocked in prod/mirror)
  //   env       — same derivation scheme, prod-legal: master keys injected via
  //               VAULT_MASTER_KEY[_V{n}] secrets, rotation via rewrap-deks.ts
  //   hashicorp — HashiCorp Vault Transit engine (VAULT_ADDR + VAULT_TOKEN)
  // Unset falls back to "dev" when DEV_VAULT_MOCK=true (legacy dev setups).
  VAULT_BACKEND: z.preprocess(emptyToUndefined, z.enum(["dev", "env", "hashicorp"]).optional()),
  VAULT_ADDR: optionalUrl,
  VAULT_TOKEN: optionalString,
  VAULT_NAMESPACE: optionalString,
  VAULT_TRANSIT_MOUNT: z.string().default("transit"),
  VAULT_TRANSIT_KEY_PREFIX: z.string().default("edams"),
  // Preferred prod name for the version-1 master key (alias of
  // DEV_VAULT_MASTER_KEY; the DEV_-prefixed names remain supported so
  // existing deployments keep decrypting without a config migration).
  VAULT_MASTER_KEY: optionalString,
  DEV_VAULT_MOCK: boolFromString.default(true),
  // Kept as the version-1 master key for backward compatibility: deployments
  // that only ever set DEV_VAULT_MASTER_KEY keep decrypting/generating DEKs
  // under version 1 unmodified. Additional versions are read directly off
  // process.env below (DEV_VAULT_MASTER_KEY_V2, _V3, ...) since Zod can't
  // validate an open-ended set of numbered keys up front.
  DEV_VAULT_MASTER_KEY: z.string().default("dms-dev-vault-key-32bytes!!"),
  // Names which numbered master-key version new DEKs are wrapped under.
  // Defaults to 1 so existing deployments with only DEV_VAULT_MASTER_KEY set
  // are unaffected. Bump this (and set DEV_VAULT_MASTER_KEY_V{n}) to rotate.
  DEV_VAULT_MASTER_KEY_CURRENT_VERSION: z.coerce.number().int().positive().default(1),
  BUSINESS_HOURS_START: z.coerce.number().default(9),
  BUSINESS_HOURS_END: z.coerce.number().default(17),
  BUSINESS_TIMEZONE: z.string().default("UTC"),
  // First segment of every letter and form reference number (PREFIX/UNIT/DEPT/TYPE/YEAR/SEQ). Existing numbers keep the prefix they were issued with;
  // changing this only affects numbers allocated afterwards.
  REFERENCE_NUMBER_PREFIX: z.string().regex(/^[A-Z0-9]{1,8}$/, "REFERENCE_NUMBER_PREFIX must be 1-8 upper-case letters or digits").default("REF"),
  CLIENT_URL: z.string().url().default("http://localhost:7101"),
  // Optional comma-separated CORS allowlist; defaults to [CLIENT_URL].
  CORS_ORIGINS: optionalString,
  // PAdES e-sign flattened copies: base64 PKCS#12 signing certificate +
  // passphrase. Unset = completed ceremonies skip the signed-copy step
  // (everything else about e-signing still works). Generate a self-signed
  // one with scripts/generate-esign-cert.js or provision an org cert.
  ESIGN_P12_B64: optionalString,
  ESIGN_P12_PASSPHRASE: optionalString,
  // AI provider config (modules/ai/llmClient.ts) — previously read via raw
  // process.env.X deep inside provider-resolution logic, bypassing this
  // schema entirely: a typo in one of these names failed silently at
  // runtime (that provider's resolver just returns null) instead of at
  // boot. Defaults match exactly what llmClient.ts hardcoded inline before.
  AI_PROVIDER: optionalString,
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_BASE_URL: optionalString,
  AI_API_KEY: optionalString,
  AI_MODEL: z.string().default('gpt-4o-mini'),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  // Per-provider VISION model override, one per provider (same pattern as
  // the plain *_MODEL vars above) — for image-input features (today: the
  // form-builder's "build from a photo or PDF"). Deliberately NOT a single
  // "the vision provider" setting: whichever provider resolveProvider() picks
  // for ordinary chat is the same one used for vision, just possibly with a
  // different model id, so this stays vendor-neutral rather than special-
  // casing any one provider as "the" vision backend.
  //
  // Defaults: OPENAI_MODEL/ANTHROPIC_MODEL already default to vision-capable
  // models (gpt-4o-mini / claude-sonnet-4-6), so their vision overrides
  // default to the exact same string — a deployment that points OPENAI_MODEL/
  // ANTHROPIC_MODEL at a non-vision model doesn't lose vision capability, and
  // one that never touches this var still gets a real, working default.
  // GROQ_VISION_MODEL/AI_VISION_MODEL default to their own plain *_MODEL
  // value instead, since neither Groq's nor an arbitrary custom endpoint's
  // default model can be assumed vision-capable (confirmed live 2026-09-15:
  // this deployment's Groq account has zero vision-capable models available)
  // — that default simply reproduces today's real "no vision on this
  // provider yet" state as an honest provider-side rejection, rather than
  // this client guessing at a model id that may not exist on the account.
  GROQ_VISION_MODEL: optionalString,
  OPENAI_VISION_MODEL: z.string().default('gpt-4o-mini'),
  AI_VISION_MODEL: optionalString,
  ANTHROPIC_VISION_MODEL: z.string().default('claude-sonnet-4-6')
})
  /**
   * Cross-field requirements: a subsystem's credentials are required only when
   * that subsystem is actually selected.
   *
   * This exists because the opposite — marking them required unconditionally —
   * produced a real production boot-blocker (see the MINIO_ACCESS_KEY comment
   * above). A deployment that does not use MinIO must not be forced to invent
   * MinIO credentials to start, and a deployment that DOES use it must not be
   * allowed to start without them. Both halves matter: making the keys simply
   * optional would trade a loud, wrong failure for a silent, real one — the
   * MinIO client would construct with empty credentials and every upload would
   * fail at runtime with an auth error instead of at boot with a clear message.
   */
  .superRefine((cfg, ctx) => {
    if (cfg.STORAGE_DRIVER === "minio") {
      for (const key of ["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"] as const) {
        if (!cfg[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=minio (set STORAGE_DRIVER=local to use the on-disk store at STORAGE_LOCAL_PATH instead)`,
          });
        }
      }
    }
    if (cfg.SEARCH_ENGINE === "meilisearch" && !cfg.MEILISEARCH_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MEILISEARCH_HOST"],
        message:
          "MEILISEARCH_HOST is required when SEARCH_ENGINE=meilisearch (set SEARCH_ENGINE=postgres to use the built-in ILIKE search instead)",
      });
    }
  });

const parsed = envSchema.parse(process.env);

function buildDatabaseUrl() {
  if (parsed.DATABASE_URL) return parsed.DATABASE_URL;
  const user = encodeURIComponent(parsed.DB_USER);
  const pass = parsed.DB_PASSWORD ? `:${encodeURIComponent(parsed.DB_PASSWORD)}` : '';
  return `postgresql://${user}${pass}@${parsed.DB_HOST}:${parsed.DB_PORT}/${parsed.DB_NAME}`;
}

export const DEV_VAULT_MASTER_KEY_PLACEHOLDER = "dms-dev-vault-key-32bytes!!";

/**
 * Map of KEK version number -> master key string. Version 1 always resolves
 * from DEV_VAULT_MASTER_KEY (the pre-rotation env var), unless explicitly
 * overridden by DEV_VAULT_MASTER_KEY_V1. Any DEV_VAULT_MASTER_KEY_V{n} env var
 * registers version n. This is read directly off process.env (not the Zod
 * schema) since the set of rotated versions is open-ended and unknown ahead
 * of time.
 */
function buildVaultMasterKeys(): Record<number, string> {
  // VAULT_MASTER_KEY (prod name) takes precedence over DEV_VAULT_MASTER_KEY
  // for version 1; likewise VAULT_MASTER_KEY_V{n} over DEV_VAULT_MASTER_KEY_V{n}.
  const keys: Record<number, string> = { 1: parsed.VAULT_MASTER_KEY ?? parsed.DEV_VAULT_MASTER_KEY };
  const legacyPattern = /^DEV_VAULT_MASTER_KEY_V(\d+)$/;
  const prodPattern = /^VAULT_MASTER_KEY_V(\d+)$/;
  for (const [envKey, value] of Object.entries(process.env)) {
    const match = legacyPattern.exec(envKey);
    if (match && value) {
      keys[Number(match[1])] = value;
    }
  }
  for (const [envKey, value] of Object.entries(process.env)) {
    const match = prodPattern.exec(envKey);
    if (match && value) {
      keys[Number(match[1])] = value;
    }
  }
  return keys;
}

/**
 * The key-management backend actually in effect. Explicit VAULT_BACKEND wins;
 * otherwise legacy DEV_VAULT_MOCK=true means "dev". Undefined = unconfigured
 * (getVaultService throws, and prod/mirror refuses to boot).
 */
export function resolveVaultBackend(): "dev" | "env" | "hashicorp" | undefined {
  if (config.VAULT_BACKEND) return config.VAULT_BACKEND;
  return config.DEV_VAULT_MOCK ? "dev" : undefined;
}

export const config = {
  ...parsed,
  DATABASE_URL: buildDatabaseUrl(),
  DATABASE_URL_EXPLICIT: Boolean(parsed.DATABASE_URL),
  DEV_VAULT_MASTER_KEYS: buildVaultMasterKeys()
};

export function assertProductionRuntimeRequirements() {
  if (config.NODE_ENV !== "production" && config.NODE_ENV !== "mirror") return;
  // FIX: an ambient DATABASE_URL used to be trusted just because its
  // credentials happened to pass the checks below (real password,
  // non-superuser) — exactly what a stray leftover Railway/Render URL from
  // an unrelated project would also look like. Require an explicit,
  // one-time acknowledgment that THIS DATABASE_URL is real prod config,
  // not a same-looking accident — see the DATABASE_URL_TRUSTED comment
  // above for the hosts (Railway/Render/Heroku-style) that legitimately
  // need to set it.
  if (config.DATABASE_URL_EXPLICIT && !config.DATABASE_URL_TRUSTED) {
    throw new Error(
      "DATABASE_URL is set but DATABASE_URL_TRUSTED is not — refusing to boot in production/mirror with an unacknowledged connection string. " +
      "If this DATABASE_URL is real intended config (e.g. a managed-hosting provider that injects it), set DATABASE_URL_TRUSTED=true. " +
      "If you didn't expect DATABASE_URL to be set at all, it's likely a stray machine-wide env var from an unrelated project — unset it and configure DB_HOST/DB_USER/DB_PASSWORD/DB_NAME instead."
    );
  }
  {
    // Same rules whether the connection comes from DB_USER/DB_PASSWORD parts
    // or an explicit DATABASE_URL: a real password, and never the postgres
    // superuser (it bypasses every RLS policy — use edams_app, see
    // migrations 20260717000002/3).
    let dbUser = config.DB_USER;
    let dbPassword = config.DB_PASSWORD;
    if (config.DATABASE_URL_EXPLICIT) {
      try {
        const url = new URL(config.DATABASE_URL);
        dbUser = decodeURIComponent(url.username);
        dbPassword = decodeURIComponent(url.password);
      } catch {
        throw new Error("DATABASE_URL is not a parseable URL");
      }
    }
    if (!dbPassword) {
      throw new Error("A database password is required in production/mirror (the empty dev default must not reach a real database)");
    }
    if (dbUser === "postgres") {
      throw new Error(
        "The database user must not be the postgres superuser in production/mirror — superuser connections bypass every RLS policy. Use the least-privilege edams_app role."
      );
    }
  }
  // Without this, getPublicKey()'s shared-public-key fallback used to become
  // the verification path for every token in production. That fallback is now
  // gated on NODE_ENV too (shared/auth.ts), so this guard closes the other half:
  // a production deploy with no JWKS endpoint cannot verify real SSO tokens at
  // all and must fail loudly at boot rather than at first login.
  if (!config.AUTH_JWKS_URI) {
    throw new Error(
      "AUTH_JWKS_URI is required in production/mirror — real SSO-issued tokens are verified against the IdP's published JWKS, and without it token verification has no key source",
    );
  }
  if (!config.AUTH_ISSUER) throw new Error("AUTH_ISSUER is required in production/mirror");
  if (!config.AUTH_AUDIENCE) throw new Error("AUTH_AUDIENCE is required in production/mirror");
  if (config.JWT_SECRET.length < 32 || config.JWT_REFRESH_SECRET.length < 32) {
    throw new Error("JWT secrets must be at least 32 characters in production/mirror");
  }
  // Only when Meilisearch is the selected search engine. This used to be
  // unconditional, which meant a deployment running the built-in Postgres
  // search — as this server does, natively, with no Meilisearch installed —
  // had to carry a 64-character key for a service that does not exist purely
  // to satisfy a boot check. That is the same defect class as the MinIO
  // credentials above: a requirement that does not match the invariant. The
  // trap it sets is real — someone tidying an unused key out of
  // `.env.production` would take the whole system down at the next restart,
  // for a subsystem that was never in use.
  if (config.SEARCH_ENGINE === "meilisearch" && !config.MEILISEARCH_MASTER_KEY) {
    throw new Error("MEILISEARCH_MASTER_KEY is required in production/mirror when SEARCH_ENGINE=meilisearch");
  }
  if (config.AUDIT_HMAC_SECRET.startsWith("change-this")) {
    throw new Error("AUDIT_HMAC_SECRET is still the .env.example placeholder in production/mirror");
  }
  if (config.STORAGE_DRIVER === "minio" && /^minioadmin/.test(config.MINIO_SECRET_KEY)) {
    throw new Error("MINIO_SECRET_KEY is still a default minioadmin credential in production/mirror");
  }
  if (config.SMTP_HOST === "localhost" || config.SMTP_HOST === "127.0.0.1") {
    throw new Error("SMTP_HOST points at localhost (the dev mailhog default) in production/mirror — configure the real SMTP relay");
  }
  if (config.EMAIL_REDIRECT_TO) {
    throw new Error(
      "EMAIL_REDIRECT_TO must be unset in production/mirror — it silently diverts every notification, approval request and dispatched letter away from its real recipient, and nothing else in the system would show that mail is not arriving",
    );
  }
  if (!config.ADMIN_ALERT_WEBHOOK_URL && !config.ADMIN_ALERT_EMAIL_TO) {
    // Not a hard refusal — DMS worked without this before it existed — but
    // silent is exactly the failure mode being fixed here: the ERR-INTERNAL
    // response text promises the team has been notified, and without either
    // var set, nothing pages anyone. Loud at boot beats discovering it during
    // a real outage.
    console.warn(
      "[WARN] Neither ADMIN_ALERT_WEBHOOK_URL nor ADMIN_ALERT_EMAIL_TO is set in production/mirror — unhandled 500s will be logged locally only, and nobody will actually be notified despite what the error response says.",
    );
  }
  if (config.LOCAL_JWT_MOCK) {
    // Still a warning, not a refusal: refusing would turn a deploy whose env file
    // was not yet updated into an outage. The 2026-07-31 decision that allowed this
    // is superseded (2026-10-04): production and mirror run with LOCAL_JWT_MOCK=false
    // and sign in through SSO only. getPublicKey no longer depends on the flag, so
    // turning it off is safe; leaving it on only keeps passwordless /auth/login open.
    console.warn("[WARN] LOCAL_JWT_MOCK is enabled in production/mirror -- passwordless /auth/login is reachable for ANY seeded email. Set LOCAL_JWT_MOCK=false: SSO sign-in does not need it.");
  }
  // DMS signs and verifies its own session tokens with this key pair (shared/auth.ts,
  // DMS_SESSION_KID). Without it no login can complete and nothing can be verified,
  // so say so at boot instead of failing every request in a confusing way.
  if (!config.DEV_RSA_PRIVATE_KEY || !config.DEV_RSA_PUBLIC_KEY) {
    throw new Error(
      "DEV_RSA_PRIVATE_KEY and DEV_RSA_PUBLIC_KEY must both be set in production/mirror — DMS signs and verifies its own session tokens with them (generate a pair with `node scripts/generate-rsa-keys.js`, distinct from every other environment's)"
    );
  }
  if (config.DEV_VAULT_MOCK) {
    throw new Error("DEV_VAULT_MOCK must not be true in production/mirror");
  }
  if (config.DEV_JWT_ISSUER || config.DEV_JWT_AUDIENCE) {
    // This already happened once in prod: a real prod-issued token's `iss`
    // claim read `http://localhost:7300` because DEV_JWT_ISSUER was set,
    // and every jwt.sign() call in auth.routes.ts prefers it via `??` over
    // AUTH_ISSUER/AUTH_AUDIENCE. Fixed that time by blanking both vars in
    // .env.production; this guard makes a repeat of that loud at boot
    // instead of silent in issued tokens.
    throw new Error(
      "DEV_JWT_ISSUER/DEV_JWT_AUDIENCE must be unset in production/mirror — they take priority over AUTH_ISSUER/AUTH_AUDIENCE in every jwt.sign() call and have already caused a real mis-issued-token incident"
    );
  }
  if (config.ENABLE_API_DOCS) {
    throw new Error("ENABLE_API_DOCS must be false in production/mirror — it disables the CSP header and serves unauthenticated Swagger UI/OpenAPI spec");
  }
  const vaultBackend = resolveVaultBackend();
  if (vaultBackend !== "env" && vaultBackend !== "hashicorp") {
    throw new Error(
      "VAULT_BACKEND must be 'env' or 'hashicorp' in production/mirror — document encryption needs a production key backend"
    );
  }
  if (vaultBackend === "hashicorp") {
    if (!config.VAULT_ADDR) throw new Error("VAULT_ADDR is required when VAULT_BACKEND=hashicorp");
    if (!config.VAULT_TOKEN) throw new Error("VAULT_TOKEN is required when VAULT_BACKEND=hashicorp");
  } else {
    // env backend: the current-version master key must be set and rotated off
    // the well-known dev placeholder (version 1 resolves from VAULT_MASTER_KEY,
    // falling back to the legacy DEV_VAULT_MASTER_KEY name).
    const currentKekVersion = config.DEV_VAULT_MASTER_KEY_CURRENT_VERSION;
    const currentKekKey = config.DEV_VAULT_MASTER_KEYS[currentKekVersion];
    if (!currentKekKey || currentKekKey === DEV_VAULT_MASTER_KEY_PLACEHOLDER) {
      const envVarName =
        currentKekVersion === 1
          ? "VAULT_MASTER_KEY (or DEV_VAULT_MASTER_KEY / *_V1)"
          : `VAULT_MASTER_KEY_V${currentKekVersion} (or DEV_VAULT_MASTER_KEY_V${currentKekVersion})`;
      throw new Error(
        `DEV_VAULT_MASTER_KEY_CURRENT_VERSION=${currentKekVersion} but ${envVarName} is unset or still the default placeholder in production/mirror`
      );
    }
    if (currentKekKey.length < 32) {
      throw new Error("The current vault master key must be at least 32 characters in production/mirror");
    }
  }
}

