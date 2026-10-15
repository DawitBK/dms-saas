import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from 'sequelize';

interface RequestContext {
  correlationId: string;
  // Stamped by tenantContext middleware (after authenticate). Lets deep call
  // sites — most importantly writeAuditLog — know the acting tenant without
  // threading it through every function signature.
  tenantId?: string;
  // Stamped by requestIdMiddleware, i.e. for EVERY request including the
  // unauthenticated ones (/auth/login is the event that most needs it).
  // Same motivation as tenantId: writeAuditLog needs the caller's address
  // and there is no route-independent way to hand it 177 call sites.
  sourceIp?: string;
  // S6-RLS: the per-request tenant-scoped transaction (see shared/middleware.ts
  // tenantContext). Sequelize's CLS adapter below reads/writes this so every
  // query made anywhere in this request's async context automatically runs
  // inside the SAME transaction/connection that carries `SET LOCAL
  // app.current_tenant` — no explicit `{ transaction }` threading required.
  transaction?: Transaction | null;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function getCorrelationId(): string | undefined {
  return requestContextStore.getStore()?.correlationId;
}

export function getRequestTenantId(): string | undefined {
  return requestContextStore.getStore()?.tenantId;
}

export function getRequestSourceIp(): string | undefined {
  return requestContextStore.getStore()?.sourceIp;
}

/** Mutates the CURRENT request's context (safe: one store object per request). */
export function setRequestTenantId(tenantId: string): void {
  const store = requestContextStore.getStore();
  if (store) store.tenantId = tenantId;
}

export function getRequestTransaction(): Transaction | null | undefined {
  return requestContextStore.getStore()?.transaction;
}

export function setRequestTransaction(transaction: Transaction | null | undefined): void {
  const store = requestContextStore.getStore();
  if (store) store.transaction = transaction;
}

export function runWithContext<T>(correlationId: string, sourceIp: string | undefined, fn: () => T): T {
  return requestContextStore.run({ correlationId, sourceIp }, fn);
}

/**
 * Adapter satisfying Sequelize's `Sequelize.useCLS()` contract — the
 * cls-hooked-shaped `{ get, set, run, bind }` interface — while actually
 * being backed by the SAME AsyncLocalStorage instance (`requestContextStore`)
 * already used for correlation IDs and tenant IDs.
 *
 * Sequelize calls `.get('transaction')` / `.set('transaction', …)` (from
 * `Transaction#prepareEnvironment` and `Model`/`Sequelize#query`) to decide
 * which transaction a query without an explicit `{ transaction }` option
 * should join. It calls `.run()` for the "managed" `sequelize.transaction(
 * async (t) => …)` auto-callback form — and this codebase uses that form in
 * ~30 places (writeAuditLog, and most service-level `sequelize.transaction`
 * calls), not just the per-request wrapper in shared/middleware.ts.
 *
 * FIX: `run()` used to be a bare pass-through — `callback(getStore())` —
 * with no real nested async context. Sequelize's managed-transaction
 * lifecycle calls `.set('transaction', newTx)` on entry and
 * `.set('transaction', null)` on exit; with no nesting, both calls mutated
 * the SAME store object the request's own transaction (from tenantContext)
 * lives in. Concretely: any managed `sequelize.transaction()` call made
 * during a request (1) silently stopped being atomic with the domain change
 * it was meant to accompany — it ran in its own transaction on a second
 * connection, not a savepoint of the request's — and (2) overwrote the
 * request's transaction reference in the shared store, so every query made
 * *after* the first such call for the rest of the request silently stopped
 * joining the request transaction (and, once RLS enforcement drops the
 * superuser DB role, would silently stop carrying `SET LOCAL
 * app.current_tenant` too).
 *
 * `run()` now gives the managed-transaction callback its OWN child
 * AsyncLocalStorage frame — a real nested context, not a shared mutation.
 * `correlationId`/`tenantId` carry forward (so logging/tenant-scoping stay
 * intact inside the nested transaction), but `transaction` starts fresh in
 * the child, so `.set()` inside the callback can never clobber the parent's
 * transaction. Once the callback returns, execution is back in the parent's
 * AsyncLocalStorage frame automatically — `getStore()` reverts to the
 * parent, whose `transaction` was never touched.
 */
export const sequelizeClsNamespace = {
  get(key: string): unknown {
    if (key !== 'transaction') return undefined;
    return requestContextStore.getStore()?.transaction;
  },
  set(key: string, value: unknown): unknown {
    if (key === 'transaction') {
      const store = requestContextStore.getStore();
      if (store) store.transaction = value as Transaction | null;
    }
    return value;
  },
  run<T>(callback: (context: unknown) => T): T {
    const parent = requestContextStore.getStore();
    const child: RequestContext = {
      correlationId: parent?.correlationId ?? '',
      tenantId: parent?.tenantId,
      sourceIp: parent?.sourceIp,
      transaction: undefined,
    };
    return requestContextStore.run(child, () => callback(child));
  },
  // Runs `fn` later with whatever context was active AT BIND TIME restored —
  // matching cls-hooked's `bind()` semantics (needed for callbacks Sequelize
  // schedules outside the original call stack, e.g. connection lifecycle
  // hooks tied to a specific managed transaction's context).
  bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const captured = requestContextStore.getStore();
    return ((...args: unknown[]) =>
      captured
        ? requestContextStore.run(captured, () => fn(...args))
        : fn(...args)) as T;
  },
};

/**
 * Wrap a body-consuming middleware so the rest of the chain runs back inside
 * the request's AsyncLocalStorage frame.
 *
 * THE BUG THIS FIXES (2026-09-09, production: every document upload over
 * 64 KB failed with a bogus "Department code is not registered").
 *
 * `requestIdMiddleware` establishes this store via `runWithContext`, and
 * everything downstream is supposed to inherit it. That holds while the chain
 * is a plain sequence of `next()` calls. It stops holding the moment a
 * middleware CONSUMES THE REQUEST STREAM: body-parser and multer both finish
 * by calling `next()` from a socket 'data'/'end' callback, and that callback
 * belongs to the async resource that read the socket — not to the frame the
 * middleware was entered in.
 *
 * The reason this looked intermittent rather than total is the 64 KB socket
 * read boundary. A body that arrives in a single read is fully buffered
 * before the parser is even invoked, so the parser calls `next()`
 * synchronously, still inside the frame, and everything works. A body that
 * spans two reads does not, and the frame is gone from there on.
 *
 * What that cost, concretely: `tenantContext` runs AFTER the parsers, so with
 * the store missing, its `setRequestTenantId`/`setRequestTransaction` calls
 * hit the `if (store)` guard and did nothing at all. The request transaction
 * was opened and carried `SET LOCAL app.current_tenant` — and then every
 * query in the request joined a DIFFERENT pooled connection that had no such
 * setting. Under RLS that means tenant-scoped tables return zero rows. It is
 * silent: no error, no log, just empty results, which is exactly how a
 * missing department became "not registered".
 *
 * Capturing the store here and re-entering it for `next` restores the frame
 * for the remainder of the chain. The captured object is the SAME object, not
 * a copy, so later mutations (tenantId, transaction) are still visible to
 * everything holding it.
 */
type ChainNext = (err?: unknown) => void;

export function preserveRequestContext<Req, Res>(
  middleware: (req: Req, res: Res, next: ChainNext) => void,
): (req: Req, res: Res, next: ChainNext) => void {
  return (req, res, next) => {
    const store = requestContextStore.getStore();
    // No ambient context (a request that somehow bypassed requestIdMiddleware,
    // or a direct unit-test call): behave exactly as the bare middleware.
    if (!store) {
      middleware(req, res, next);
      return;
    }
    middleware(req, res, (err?: unknown) => {
      requestContextStore.run(store, () => next(err));
    });
  };
}
