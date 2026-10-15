import compression from 'compression';
import cookieParser from 'cookie-parser';
import { preserveRequestContext } from './shared/requestContext.js';
import cors from 'cors';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import forge from 'node-forge';
import swaggerUi from 'swagger-ui-express';
import { config } from './config/env.js';
import { v1Routes } from './api/v1/index.js';
import {
  errorHandler,
  requestIdMiddleware,
  requestLogger,
} from './shared/middleware.js';
import { authenticate, requirePermission } from './shared/auth.js';
import { PERMISSIONS } from './config/permissions.js';
import { createTusHandler } from './modules/documents/tusUpload.js';
import { metricsMiddleware } from './infrastructure/metrics.js';
import { createRedisRateLimitStore } from './infrastructure/cache/rateLimitStore.js';
import { tenantAwareKeyGenerator } from './shared/rateLimitKey.js';

// JWKS cached in-process â€” recomputing RSA key on every request is unnecessary
let jwksCache: { keys: unknown[] } | null = null;

export function createApp() {
  const app = express();
  const use = app.use.bind(app) as any;

  // MUST be set before any per-IP middleware below reads `req.ip` (the rate
  // limiters) and before any route records it (audit `source_ip`). Express
  // defaults this to false, which in production collapsed every user in the
  // organisation onto the Apache proxy's single address — see TRUST_PROXY in
  // config/env.ts for what that silently broke. A numeric string is passed as
  // a number (Express reads "1" as a literal address but 1 as a hop count),
  // a comma-separated list as an array; anything else goes through verbatim,
  // which covers `loopback` (the default).
  const trustProxy = config.TRUST_PROXY.trim();
  if (trustProxy === 'false') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(trustProxy)) {
    app.set('trust proxy', Number(trustProxy));
  } else if (trustProxy.includes(',')) {
    app.set('trust proxy', trustProxy.split(',').map((v) => v.trim()).filter(Boolean));
  } else {
    app.set('trust proxy', trustProxy);
  }

  // The API serves JSON only, so a deny-everything CSP is safe and shields
  // any reflected-content edge case. Exception: dev API docs (swagger UI)
  // need inline scripts — CSP stays off when docs are enabled (never in prod).
  use(helmet({
    contentSecurityPolicy: config.ENABLE_API_DOCS
      ? false
      : {
          directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'none'"],
          },
        },
    // FIX: helmet's default `Cross-Origin-Resource-Policy: same-origin` is
    // enforced by the BROWSER independently of CORS — it blocks a
    // cross-origin `fetch()`/XHR from ever reading the response body, even
    // with fully correct Access-Control-Allow-* headers. This API is always
    // consumed cross-origin, by the separate frontend origin (different
    // port = different origin even on localhost), so the default silently
    // broke every fetch-based document download/preview (signing field
    // placer, the detail page's File tab) with a bare "Failed to fetch" —
    // invisible to server-side testing (curl doesn't enforce CORP, so it
    // always looked like a working 200 from the backend's side).
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  // Allowed browser origins: CORS_ORIGINS (comma-separated) when set,
  // otherwise the single CLIENT_URL. The extra localhost origin is a dev
  // convenience only — it must never ride into a production allowlist that
  // sends credentialed responses.
  const configuredOrigins = config.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  const corsOrigins = configuredOrigins?.length ? configuredOrigins : [config.CLIENT_URL];
  if (config.NODE_ENV === 'development' || config.NODE_ENV === 'test') {
    corsOrigins.push('http://localhost:3002');
  }
  // exposedHeaders: response headers a cross-origin fetch is normally
  // forbidden from reading at all (browsers only expose the CORS "simple
  // response header" whitelist by default) — X-Letter-Block-Pages carries the
  // live letter preview's per-block page map (letters.routes.ts's
  // POST /preview-pdf) so the compose page can jump the preview to whatever
  // page the author's caret is on.
  use(cors({ origin: corsOrigins, credentials: true, exposedHeaders: ['X-Letter-Block-Pages'] }));
  use(compression());
  use(cookieParser());
  use(requestIdMiddleware);
  use(requestLogger);
  use(metricsMiddleware);

  // Auth endpoints: IP-based limiter (brute-force / credential-stuffing
  // protection) in production, relaxed in dev/test for test runners.
  //
  // Raised 2026-09-23 (20/10/800 -> below): those numbers were sized for a
  // handful of concurrent users and, combined with tenantAwareKeyGenerator
  // pooling every request by TENANT (not per real client), meant the whole
  // company shared one 800 req/min bucket for the general API and one 20
  // req/min bucket for logins — a normal office login rush or a few active
  // admins on a multi-tab page presented as a mysterious 429 storm, not a
  // real attack. These limiters exist to keep out malicious bots/credential
  // stuffing, not to ration real, legitimate traffic — sized now for
  // thousands of real concurrent users while still capping a genuinely
  // automated flood at each layer.
  const authLimit = config.NODE_ENV === 'production' ? 300 : 1000;
  const uploadLimit = config.NODE_ENV === 'production' ? 300 : 500;
  use('/api/v1/auth', rateLimit({ windowMs: 60_000, limit: authLimit, standardHeaders: true, legacyHeaders: false, store: createRedisRateLimitStore('auth') }));
  // TEN-2: both limiters below run BEFORE authenticate() (this app mounts
  // auth per-router, not globally), but a real bearer token is already
  // present on every authenticated call by this point — tenantAwareKeyGenerator
  // keys by tenant_id (unverified, bucketing-only — see its own doc comment)
  // so tenants sharing a corporate NAT egress no longer share one bucket.
  // Upload endpoints: separate limit so one uploader can't starve others
  use('/api/v1/documents/upload', rateLimit({ windowMs: 60_000, limit: uploadLimit, standardHeaders: true, legacyHeaders: false, store: createRedisRateLimitStore('upload'), keyGenerator: tenantAwareKeyGenerator }));
  // General protection (generous — per-user limiting is applied on protected routes after auth)
  use('/api', rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'production' ? 20_000 : 5000, standardHeaders: true, legacyHeaders: false, store: createRedisRateLimitStore('global'), keyGenerator: tenantAwareKeyGenerator }));

  // Tus resumable upload â€” mounted BEFORE express.json() so tus can handle
  // the raw PATCH request body (binary file chunks) without JSON parsing interference.
  // The authenticate middleware reads only the Authorization header, so it works here.
  const TUS_PATH = `${config.API_BASE_PATH}/documents/upload/tus`;
  const tusHandler = createTusHandler();
  // H3: the tus endpoint previously ran on `authenticate` alone (its only gate
  // was a role denylist inside the handler), so any role lacking document:upload
  // — e.g. AUDITOR — could create documents here, unlike the buffered upload
  // route. Enforce the same permission the buffered route uses.
  const requireUpload = requirePermission(PERMISSIONS.DOCUMENT_UPLOAD);
  app.all(TUS_PATH, authenticate as any, requireUpload as any, tusHandler);
  app.all(`${TUS_PATH}/*path`, authenticate as any, requireUpload as any, tusHandler);

  // preserveRequestContext: both parsers consume the request stream, and a
  // body over the 64 KB socket read boundary makes them call next() from a
  // socket callback OUTSIDE the AsyncLocalStorage frame requestIdMiddleware
  // established. Everything after them -- including tenantContext, which is
  // what registers the tenant-scoped transaction -- then ran with no store,
  // so its writes silently no-opped and every query in the request escaped
  // the transaction carrying SET LOCAL app.current_tenant. Under RLS that
  // means zero rows, with no error. See shared/requestContext.ts.
  use(preserveRequestContext(express.json({ limit: '50mb' })));
  use(preserveRequestContext(express.urlencoded({ extended: true })));

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'dms-backend' }));
  app.get(`${config.API_BASE_PATH}/health`, (_req, res) => res.json({ status: 'ok', service: 'dms-backend' }));

  // Unauthenticated Prometheus scrape endpoint, opt-in via
  // ENABLE_PUBLIC_METRICS_ROUTE. "Public" means unauthenticated on THIS
  // listener only — enable it solely when the API port is not directly
  // internet-exposed (the prod compose scrapes over the internal Docker
  // network and the Caddy vhost explicitly refuses /metrics). The
  // authenticated /api/v1/metrics route remains for operators.
  if (config.ENABLE_PUBLIC_METRICS_ROUTE) {
    app.get('/metrics', async (_req, res) => {
      const { renderMetrics, metricsContentType } = await import('./infrastructure/metrics.js');
      res.setHeader('Content-Type', metricsContentType);
      res.send(await renderMetrics());
    });
  }

  // S6-02: JWKS endpoint â€” result cached in memory after first computation
  app.get('/.well-known/jwks.json', (_req, res, next) => {
    try {
      if (!config.DEV_RSA_PUBLIC_KEY) {
        // Plain-string `{error: '...'}` bodies here used to bypass the app's
        // one error envelope (`{error:{code,message}}`) that apiClient.ts's
        // frontend interceptor actually parses — a caller saw axios's own
        // generic "Request failed with status code 503" instead of this.
        res.status(503).json({ error: { code: 'ERR-JWKS-NOT-CONFIGURED', message: 'JWKS not configured' } });
        return;
      }
      if (!jwksCache) {
        const pem = Buffer.from(config.DEV_RSA_PUBLIC_KEY, 'base64').toString('utf-8');
        const publicKey = forge.pki.publicKeyFromPem(pem) as any;
        const n = Buffer.from(publicKey.n.toByteArray()).toString('base64url');
        const e = Buffer.from(publicKey.e.toByteArray()).toString('base64url');
        const kid = crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
        jwksCache = { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid, n, e }] };
      }
      res.set('Cache-Control', 'public, max-age=3600');
      res.json(jwksCache);
    } catch (error) {
      // Route to the central handler instead of a bare, differently-shaped
      // 500 — errorHandler logs it consistently and, in dev, attaches the
      // real cause instead of this silently discarding it.
      next(error);
    }
  });

  // Cache-Control middleware â€” applied to all GET routes.
  // req.path at app-level includes the full path (e.g. /api/v1/documents).
  // We strip the API_BASE_PATH prefix so patterns can match the route segment.
  const apiBase = config.API_BASE_PATH; // e.g. '/api/v1'
  function cacheControl(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    if (req.method !== 'GET') return next();

    // Strip base path so '/api/v1/documents' becomes '/documents'
    const raw = req.path;
    const path = raw.startsWith(apiBase) ? raw.slice(apiBase.length) : raw;

    if (path.startsWith('/audit')) {
      res.set('Cache-Control', 'no-store');
    } else if (path.startsWith('/auth/me')) {
      res.set('Cache-Control', 'private, max-age=60');
    } else if (
      path.startsWith('/document-types') ||
      path.startsWith('/departments') ||
      path.startsWith('/roles')
    ) {
      // FIX 2026-09-14: was `private, max-age=300` — with no ETag/validator
      // anywhere on these responses, that's a plain 5-minute browser HTTP
      // cache, consulted by axios/fetch *before* the request ever reaches
      // this server. React Query's `invalidateQueries()` after a
      // create/update/delete mutation only invalidates its OWN in-memory
      // cache and re-issues the GET — it has no way to force that GET past
      // the browser's HTTP cache. Net effect: the admin CRUD panels for
      // departments/document-types/roles could silently keep showing
      // pre-mutation data for up to 5 minutes after a successful write
      // (confirmed via direct DB/audit-log inspection that the write itself
      // was correct — this was a stale-read bug, not a data-loss bug).
      // These are exactly the three GETs whose own panels let the caller
      // mutate the underlying rows, so — like `/audit` above — they must
      // never be transparently served from cache.
      res.set('Cache-Control', 'no-store');
    } else if (
      path.startsWith('/retention/policies') ||
      path.startsWith('/search/saved')
    ) {
      res.set('Cache-Control', 'private, max-age=120');
    } else if (path.startsWith('/documents/') && path !== '/documents/stats') {
      // FIX 2026-10-10: a single document's detail, history, versions and lock status are read by the very page that changes them
      // (classification, status, checkout, a new version) and, since classification now decides who may open a document, must never be
      // answered from the browser's own cache. Found by the browser test that changed a class and saw the badge not move. The list
      // and the dashboard counters below keep their short cache.
      res.set('Cache-Control', 'no-store');
    } else if (
      path.startsWith('/documents') ||
      path.startsWith('/workflow') ||
      path.startsWith('/notifications')
    ) {
      res.set('Cache-Control', 'private, max-age=10');
    } else if (path.startsWith('/users')) {
      // FIX 2026-09-14: same class of bug as the department/document-type/
      // roles fix above, just not caught in that pass — was
      // `private, max-age=30`, no ETag/validator, so the browser's own HTTP
      // cache (consulted before the request reaches this server) could
      // serve a stale GET /users/me for up to 30s after a successful
      // self-service write through this exact prefix (PUT
      // /users/me/signature-image, /users/me/exec-notice-opt-out,
      // /users/me/notification-prefs), on top of the admin Users panel's
      // own create/edit/deactivate mutations. Reproduced live: a just-saved
      // handwritten signature (200 success toast, confirmed written) didn't
      // render until the 30s window lapsed. Every route under this prefix
      // lets its own caller mutate the rows it reads, so — like `/audit`
      // and the departments/document-types/roles bucket — it must never be
      // transparently served from cache.
      res.set('Cache-Control', 'no-store');
    } else if (path.startsWith('/letters') || path.startsWith('/forms')) {
      // FIX 2026-09-15: same class of bug as the document-types/departments/
      // roles/users buckets above — both prefixes were falling through to the
      // generic `private, max-age=10` bucket below with no ETag/validator,
      // and both letters' detail page and the forms templates/fill panels
      // read a GET under their own prefix from the exact same page that lets
      // the caller mutate it (submit/decide/cancel/dispatch a letter;
      // create/edit a template, fill an instance). No caller of either
      // prefix benefits from a browser-cacheable response, so — like those —
      // it must never be transparently served from cache.
      res.set('Cache-Control', 'no-store');
    } else if (
      path.startsWith('/approvals') ||
      path.startsWith('/org-units') ||
      path.startsWith('/folders') ||
      path.startsWith('/acl') ||
      path.startsWith('/access-rules') ||
      path.startsWith('/signing') ||
      path.startsWith('/bundles') ||
      path.startsWith('/webhooks') ||
      path.startsWith('/legal-hold') ||
      path.startsWith('/tenants') ||
      path.startsWith('/assignment-advisory')
    ) {
      // FIX 2026-10-10: same class of bug as the buckets above. These prefixes fell through to the generic
      // `private, max-age=10` bucket, and each one is read by the very screen that mutates it (switch an approval
      // recipe off, decide a step, re-activate a folder, grant or revoke access, sign, delete a webhook): React
      // Query's invalidate re-issues the GET, which the browser answered from its own HTTP cache for up to 10 s,
      // so the screen kept showing the pre-mutation list. Found by the browser test that switches a recipe off and
      // saw the card stay. None of these benefits from a cacheable response.
      res.set('Cache-Control', 'no-store');
    } else if (path.startsWith('/operations/health')) {
      res.set('Cache-Control', 'no-cache');
    } else {
      res.set('Cache-Control', 'private, max-age=10');
    }
    next();
  }

  use(cacheControl);
  app.use(config.API_BASE_PATH, v1Routes);

  if (config.ENABLE_API_DOCS) {
    use(
      '/api-docs',
      swaggerUi.serve,
      swaggerUi.setup(undefined, { swaggerUrl: '/api/openapi.yaml' }),
    );
    use('/api/openapi.yaml', express.static('docs/api/openapi.yaml'));
  }

  // An unmatched route (typo'd path, retired endpoint, probing) used to fall
  // through to Express's own bare `finalhandler`, which answers with plain
  // text/HTML ("Cannot GET /path") — every other response in this API is the
  // `{error:{code,message}}` envelope, and apiClient.ts's frontend
  // interceptor only knows how to read that shape.
  use((req: express.Request, res: express.Response) => {
    res.status(404).json({ error: { code: 'ERR-ROUTE-NOT-FOUND', message: `No route matches ${req.method} ${req.path}` } });
  });

  use(errorHandler);
  return app;
}

