// SPRINT-1/2: request/error middleware stays stable while auth, permission, and audit semantics change.
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import pinoHttpDefault from "pino-http";
import { AppError } from "../core/AppError.js";
import { logger } from "../core/logger.js";
import { sequelize } from "../infrastructure/database/index.js";
import { ZodError } from "zod";
import type { Permission } from "../config/permissions.js";
import { runWithContext, setRequestTenantId, setRequestTransaction, getRequestTenantId } from "./requestContext.js";
import { describeDatabaseError, isCapacityError, isInvalidTextRepresentation } from "./dbErrors.js";
import { config } from "../config/env.js";
import { requestsInFlight, requestsShed } from "../infrastructure/metrics.js";
import { recordSystemError } from "../infrastructure/alerting/adminAlerts.js";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = req.header("x-correlation-id") ?? req.header("x-request-id") ?? crypto.randomUUID();
  req.id = requestId;
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-correlation-id", requestId);
  // Run the remainder of the request chain inside the AsyncLocalStorage context
  // so services can read the correlationId without passing it explicitly.
  //
  // `req.ip` goes in alongside it so writeAuditLog can default audit_logs
  // .source_ip from it. It has to be captured HERE rather than in
  // tenantContext: this middleware runs for every request, and the events
  // whose source address matters most (AUTH_LOGIN, AUTHN_FAILURE) happen
  // before any tenant is even known. Reading `req.ip` — not the raw
  // X-Forwarded-For header — is what makes the value trustworthy; see
  // TRUST_PROXY in config/env.ts.
  runWithContext(requestId, req.ip, () => next());
}

const pinoHttp = pinoHttpDefault as unknown as typeof import("pino-http").default;
export const requestLogger = pinoHttp({ logger });

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  if (error instanceof ZodError) {
    const flattened = error.flatten();
    res.status(400).json({
      error: {
        code: "ERR-VALIDATION",
        message: "Validation failed",
        details: {
          fieldErrors: flattened.fieldErrors,
          formErrors: flattened.formErrors,
        },
      },
    });
    return;
  }
  // FIX (2026-09-03 audit): a malformed id in a path/query param (`GET
  // /documents/not-a-uuid`) reached Postgres as `uuid = 'not-a-uuid'` and came
  // back as SQLSTATE 22P02 "invalid input syntax for type uuid", which fell
  // through to the catch-all below as a 500. Nine of fifteen probed resource
  // routes behaved that way (documents, letters, users, departments, signing,
  // document-types, forms/templates, bundles, access-rules), so any
  // authenticated caller could produce server errors at will — inflating
  // error-rate alerts and burying real 500s. It is a malformed request, not a
  // server fault: 400. Handled centrally so every route is covered, including
  // ones added later, rather than sprinkling per-route uuid validators.
  if (isInvalidTextRepresentation(error)) {
    res.status(400).json({
      error: { code: "ERR-INVALID-ID", message: "A path or query parameter is not a valid identifier" },
    });
    return;
  }
  // body-parser (mounted as express.json()/express.urlencoded() in app.ts)
  // throws these as plain errors carrying `.type`/`.status`, not an AppError —
  // a malformed JSON body or one over the 50 MB limit used to fall straight
  // through to the generic 500 below for what is genuinely a 4xx-class
  // problem with the REQUEST, not the server.
  const bodyParserErrorType = (error as { type?: unknown } | null)?.type;
  if (bodyParserErrorType === "entity.parse.failed") {
    res.status(400).json({ error: { code: "ERR-INVALID-JSON", message: "The request body is not valid JSON" } });
    return;
  }
  if (bodyParserErrorType === "entity.too.large") {
    res.status(413).json({ error: { code: "ERR-PAYLOAD-TOO-LARGE", message: "The request body is too large" } });
    return;
  }

  // R-01: over-capacity is not a bug. A pool-acquire timeout, a statement
  // aborted by DB_STATEMENT_TIMEOUT_MS, or a transaction reclaimed by
  // DB_IDLE_IN_TRANSACTION_TIMEOUT_MS all used to surface as a bare 500 —
  // indistinguishable in logs, alerts and client retry logic from a genuine
  // application fault, and telling the caller not to retry something a retry
  // would likely have succeeded at. 503 + Retry-After says what is true.
  if (isCapacityError(error)) {
    requestsShed.inc({ reason: "pool_timeout" });
    logger.warn({ error }, "request refused: database capacity exhausted");
    // A DB/pool fault, not a request-shape fault — exactly the kind of "db"
    // failure that belongs in the same alerting/panel as ERR-INTERNAL, even
    // though it responds 503 rather than 500. Throttled per route like every
    // other fingerprint, so a sustained overload alerts once, not per request.
    recordSystemError({
      method: req.method,
      route: req.route?.path ?? req.path,
      errorName: "DatabaseCapacityExhausted",
      errorMessage: error instanceof Error ? error.message : String(error),
      requestId: req.id ?? "unknown",
      tenantId: getRequestTenantId(),
    });
    res.setHeader("Retry-After", "2");
    res.status(503).json({
      error: {
        code: "ERR-CAPACITY",
        message: "The server is at capacity. Please retry in a moment.",
      },
    });
    return;
  }
  // Safety net for every constraint violation NOT already pre-checked by the
  // service that triggered it (see dbErrors.ts's header comment) — a unique/
  // foreign-key/not-null/check-constraint violation is a caller-fixable 4xx,
  // built from Postgres's own table/column/constraint names, never a bare
  // "Internal server error". Logged at warn, not error: these are expected,
  // caller-triggerable outcomes (a duplicate code, a stale reference), not
  // application bugs — reserving `logger.error` below for the ones that
  // actually are.
  const described = describeDatabaseError(error);
  if (described) {
    logger.warn({ error, code: described.code }, "database constraint violation");
    res.status(described.statusCode).json({ error: { code: described.code, message: described.message } });
    return;
  }

  // Everything below this line is a genuine, unclassified fault — the one
  // case where "Internal server error" is honest rather than lazy. It still
  // carries the request id (already echoed on the `x-request-id` response
  // header by requestIdMiddleware) so a user can hand it to support and an
  // operator can grep this exact log line straight out of `logger.error`
  // below, and — development/test only, never mirror/production, since a
  // stack trace can leak file paths, query text and internal structure — the
  // real error name/message/stack so a developer sees the actual fault
  // immediately instead of re-triggering it locally to find out what broke.
  logger.error({ error, requestId: req.id }, "unhandled error");
  // Backs the response text below ("The team has been notified") with an
  // actual notification — see infrastructure/alerting/adminAlerts.ts's header
  // comment for why this used to be false. Never awaited: alerting must not
  // add latency to an already-failing request, and recordSystemError itself
  // never throws.
  recordSystemError({
    method: req.method,
    route: req.route?.path ?? req.path,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    requestId: req.id ?? "unknown",
    tenantId: getRequestTenantId(),
  });
  const includeDebugDetail = config.NODE_ENV === "development" || config.NODE_ENV === "test";
  res.status(500).json({
    error: {
      code: "ERR-INTERNAL",
      message: "Something went wrong on our end. The team has been notified — if this keeps happening, please share the reference below.",
      requestId: req.id,
      ...(includeDebugDetail
        ? {
            debug: {
              name: error instanceof Error ? error.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          }
        : {}),
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// R-01: admission control.
//
// tenantContext below holds one pooled DB connection for the whole lifetime of
// every authenticated request, so DB_POOL_MAX is a hard ceiling on concurrency
// — and the behaviour AT that ceiling was the problem, more than the ceiling
// itself. Every request past it queued inside Sequelize's pool for up to
// DB_POOL_ACQUIRE_MS (30s by default) while holding its socket, its parsed
// body and its entire async context, and then failed. A burst therefore turned
// into thousands of requests each waiting half a minute to be refused, with
// memory climbing the whole time and clients timing out and retrying into the
// same queue. Slowness compounds into an outage that way.
//
// This bounds the queue instead. Past the limit a request is refused
// immediately and cheaply with 503 + Retry-After, which is honest (the server
// genuinely cannot take it) and recoverable (the client can retry). Serving
// full-speed responses up to capacity and refusals past it beats serving
// timeouts to everyone.
//
// Counted here rather than inside tenantContext so the refusal happens BEFORE
// a connection is requested — the point is to not join the queue at all.
// ───────────────────────────────────────────────────────────────────────────
let inFlightRequests = 0;

function admissionLimit(): number {
  // 0 = derive. One queued request per pooled connection.
  return config.REQUEST_ADMISSION_MAX > 0 ? config.REQUEST_ADMISSION_MAX : config.DB_POOL_MAX * 2;
}

export function admissionControl(req: Request, res: Response, next: NextFunction) {
  if (inFlightRequests >= admissionLimit()) {
    requestsShed.inc({ reason: "admission_limit" });
    logger.warn(
      { inFlight: inFlightRequests, limit: admissionLimit(), path: req.path },
      "request shed: admission limit reached",
    );
    // Runs BEFORE tenantContext, so no request-scoped id/tenant exists yet —
    // still worth surfacing on the same admin alert/panel as every other
    // fault, since sustained shedding means the whole API is overloaded.
    recordSystemError({
      method: req.method,
      route: req.path,
      errorName: "AdmissionLimitReached",
      errorMessage: `${inFlightRequests}/${admissionLimit()} in-flight requests`,
      requestId: req.id ?? "unknown",
    });
    res.setHeader("Retry-After", "1");
    res.status(503).json({
      error: {
        code: "ERR-OVERLOADED",
        message: "The server is handling too many requests. Please retry in a moment.",
      },
    });
    return;
  }

  inFlightRequests += 1;
  requestsInFlight.set(inFlightRequests);

  // Both events, once, whichever comes first: "finish" for a normal response,
  // "close" for a client that disconnected mid-flight. Leaking a slot here
  // would ratchet the counter up until the process refused everything, so the
  // release is idempotent rather than relying on exactly one firing.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlightRequests -= 1;
    requestsInFlight.set(inFlightRequests);
  };
  res.once("finish", release);
  res.once("close", release);

  next();
}

/** Test seam: reset the in-flight counter between cases. */
export function __resetAdmissionControl(): void {
  inFlightRequests = 0;
  requestsInFlight.set(0);
}

/** Current in-flight count — for tests and the operations health payload. */
export function currentInFlightRequests(): number {
  return inFlightRequests;
}

// S1-06 / S6-RLS: tenantContext middleware.
//
// Why this can't be a bare `SET app.current_tenant = …` on whatever pooled
// connection Sequelize hands the next query:
//   1. `SET` (session-level) sticks to the physical connection. Sequelize
//      returns connections to its pool between queries, so a LATER request
//      for a DIFFERENT tenant can be handed that same connection with the
//      PREVIOUS tenant's session variable still set — cross-tenant leakage.
//   2. Even `SET LOCAL` (transaction-scoped, which resets automatically on
//      commit/rollback) is only meaningful if the request's queries actually
//      run inside the transaction that issued it. A bare `sequelize.query()`
//      call has no transaction at all, so `SET LOCAL` here would reset
//      before the next statement ever ran.
//
// Fix: open one transaction for the whole request, run `SET LOCAL
// app.current_tenant` as its first statement, and register that transaction
// as the CLS "current transaction" (shared/requestContext.ts,
// `sequelizeClsNamespace`, wired via `Sequelize.useCLS()` in
// infrastructure/database/sequelize.ts). Every subsequent query in this
// request's async context — including ones deep in service code that never
// received a `transaction` parameter — automatically joins it. The
// transaction is committed or rolled back once the HTTP response completes.
//
// NOTE ON CONNECTION POOL USAGE: this holds one pooled connection for the
// full lifetime of every authenticated request (not just per-query as
// before), which changes pool pressure — see the pool-sizing item in Phase 6
// (`pool.max` in infrastructure/database/sequelize.ts) for the follow-up.
//
// NOTE: RLS policies alone do nothing while the app connects as a Postgres
// superuser (see the DB_USER=postgres note in migrations/20260703* — Postgres
// superusers bypass RLS unconditionally, server-side, regardless of policy
// content). This middleware makes the mechanism correct FOR WHEN the app is
// switched to a non-superuser role (e.g. `edams_app`); it does not itself
// enable enforcement in an environment still connecting as `postgres`.
export async function tenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.tenantId) {
    next();
    return;
  }

  const tenantId = req.user.tenantId;
  const userId = req.user.userId;
  // Make the acting tenant available to deep call sites (audit stamping)
  // via AsyncLocalStorage — no signature threading required.
  setRequestTenantId(tenantId);

  let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
  let settled = false;

  const settle = async (commit: boolean) => {
    if (settled || !transaction) return;
    settled = true;
    try {
      if (commit) {
        await transaction.commit();
      } else {
        await transaction.rollback();
      }
    } catch (error) {
      logger.error({ error, tenantId }, "Failed to finalize tenant-scoped request transaction");
    } finally {
      setRequestTransaction(undefined);
    }
  };

  try {
    // Unmanaged transaction: we own commit/rollback timing (tied to the HTTP
    // response) instead of Sequelize's auto-callback form.
    transaction = await sequelize.transaction();
    setRequestTransaction(transaction);
    // R-01: bound how long this request may hold the connection it just
    // checked out. Sent as ONE multi-statement simple query alongside the
    // tenant GUC, so it costs no extra round trip.
    //
    // SET LOCAL, not a connection-level default in dialectOptions,
    // deliberately: the same Sequelize instance is used by the Umzug
    // migration runner, the BullMQ workers and the one-off backfill scripts,
    // where a 30s statement cap would abort a legitimate long CREATE INDEX or
    // a multi-minute backfill. Transaction-scoped also means it resets on
    // commit/rollback, so nothing leaks onto the pooled connection — the same
    // reason app.current_tenant is set this way (see above).
    //
    // The two numbers are interpolated rather than bound as parameters
    // because SET LOCAL does not accept parameters; they are integers
    // validated by the env schema, never request input.
    // app.current_user_id: a second GUC alongside the tenant one, letting
    // RLS policies grant "you can always see your own row" independent of
    // tenant membership — see the users_tenant_isolation policy fix
    // (migrations/20260914000003) for why that's needed: a PLATFORM_ADMIN
    // can switch into a tenant with no user_tenants row there at all
    // (auth.service.ts's switchTenant bypass), and GET /users/me asking for
    // that same account's own identity isn't tenant-scoped data the way a
    // document or department is.
    await sequelize.query(
      `SET LOCAL app.current_tenant = :tenantId;` +
        ` SET LOCAL app.current_user_id = :userId;` +
        ` SET LOCAL statement_timeout = ${config.DB_STATEMENT_TIMEOUT_MS};` +
        ` SET LOCAL idle_in_transaction_session_timeout = ${config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      {
        transaction,
        replacements: { tenantId, userId },
      },
    );
  } catch (error) {
    logger.error({ error, tenantId }, "Failed to establish tenant context");
    if (transaction) {
      await transaction.rollback().catch(() => {});
    }
    setRequestTransaction(undefined);
    next(new AppError(500, "ERR-TENANT-CONTEXT", "Failed to establish tenant context"));
    return;
  }

  // FIX: committing on `res.once('finish', ...)` — which fires AFTER the
  // response body has already left the server — meant that if the commit
  // itself then failed (a serialization failure, a deferred constraint, a
  // dropped connection), the client had already received a 2xx for a change
  // that had just been rolled back, with only a log line to show for it. It
  // also broke read-your-writes: an immediate follow-up request could land
  // on a different connection and not see what its prior 2xx implied was
  // committed. Patch res.json/res.send so the commit happens BEFORE the
  // response is actually flushed — the route handler still just calls
  // res.json(...) as normal; this intercepts that call, commits first, and
  // only forwards to the real json/send (and thus to the client) once the
  // commit has genuinely succeeded. A commit failure here sends a 500
  // instead of the handler's original success body.
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  const commitThenSend = async (
    original: (body?: unknown) => Response,
    body: unknown,
  ): Promise<Response> => {
    if (settled || !transaction) return original(body);
    if (res.statusCode >= 400) {
      // Error responses roll back rather than commit; the body being sent
      // is already an error payload, so there's no "false success" risk —
      // still await it so the transaction is genuinely closed before the
      // socket write starts.
      await settle(false);
      return original(body);
    }
    try {
      await transaction.commit();
      settled = true;
      setRequestTransaction(undefined);
    } catch (error) {
      settled = true;
      setRequestTransaction(undefined);
      logger.error({ error, tenantId }, "Failed to commit tenant-scoped request transaction before sending response");
      res.status(500);
      return originalJson({ error: { code: "ERR-COMMIT-FAILED", message: "Failed to persist changes" } });
    }
    return original(body);
  };

  res.json = ((body?: unknown) => {
    void commitThenSend(originalJson, body);
    return res;
  }) as typeof res.json;
  res.send = ((body?: unknown) => {
    void commitThenSend(originalSend, body);
    return res;
  }) as typeof res.send;

  // Safety nets, not the primary path any more: roll back if the connection
  // is torn down before any response was ever sent (client abort / handler
  // crash before calling res.json/res.send at all), or if somehow neither
  // patched method fired but the response still finished (e.g. res.end()
  // called directly, bypassing json/send). `settled` makes whichever path
  // gets there first win.
  res.once("finish", () => {
    void settle(res.statusCode < 400);
  });
  res.once("close", () => {
    void settle(false);
  });

  next();
}

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
    user?: {
      userId: string;
      role: string; // Display role (highest-ranked)
      roles: string[]; // Phase 1: All assigned roles
      tenantId: string;
      permissions: Permission[];
    };
  }
}
