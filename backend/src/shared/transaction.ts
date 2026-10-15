import type { Transaction, TransactionOptions } from "sequelize";
import { sequelize } from "../infrastructure/database/index.js";
import { getRequestTransaction } from "./requestContext.js";

/**
 * Replacement for the "managed callback" form `sequelize.transaction(async (t) => ...)`
 * at request-path call sites (writeAuditLog and ~30 service methods).
 *
 * Why this exists: Sequelize's CLS integration (see requestContext.ts's
 * `sequelizeClsNamespace`) only auto-injects the ambient transaction into
 * individual queries that omit an explicit `{ transaction }` option — it does
 * NOT make `sequelize.transaction(callback)` itself join an ambient one as a
 * savepoint. Every managed-form call inside a request therefore opened its own
 * independent root transaction on a SECOND pooled connection, with three real
 * consequences: (1) writeAuditLog wasn't actually atomic with the domain change
 * it's meant to accompany — a request that later rolled back still left behind
 * an audit row for something that never happened; (2) once the DB role is
 * switched to the restricted, non-superuser role RLS enforcement requires, that
 * second connection carries no `SET LOCAL app.current_tenant` and would
 * silently see/write zero rows; (3) every audited request held two pooled
 * connections concurrently, halving real request throughput against
 * `DB_POOL_MAX`.
 *
 * Fix: if a request-scoped transaction is already open (`tenantContext` in
 * shared/middleware.ts), reuse it directly instead of opening a new one — the
 * callback's work becomes part of the SAME transaction, so it commits/rolls
 * back atomically with the rest of the request and always carries the
 * request's tenant GUC. Outside a request (background workers, scripts, tests
 * with no ambient transaction), this transparently falls back to a real
 * `sequelize.transaction()`, identical to the old behavior — workers already
 * manage their own transaction/tenant-GUC scope via `withWorkerTenantContext`
 * and are unaffected by this change.
 */
export async function runInTransaction<T>(
  fn: (t: Transaction) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const ambient = getRequestTransaction();
  if (ambient) {
    return fn(ambient);
  }
  return options ? sequelize.transaction(options, fn) : sequelize.transaction(fn);
}

/**
 * Run `fn` behind a real rollback boundary: a SAVEPOINT child of the ambient
 * request transaction when one is open, or its own transaction otherwise.
 *
 * This is for best-effort work embedded in a larger request transaction. A
 * plain try/catch around ambient-transaction queries is NOT a rollback
 * boundary — if any statement inside errors, Postgres aborts the ENTIRE
 * request transaction (SQLSTATE 25P02): the JS catch swallows the exception,
 * but every later statement in the request fails and the request's own commit
 * rolls everything back. With a savepoint, an error rolls back only `fn`'s
 * work (Sequelize issues ROLLBACK TO SAVEPOINT on the same connection, so the
 * request transaction — and its `SET LOCAL app.current_tenant` GUC — survives
 * un-poisoned) and then rethrows for the caller's catch to handle.
 *
 * Queries inside `fn` need no explicit `{ transaction }`: the managed callback
 * form runs in its own CLS frame carrying the savepoint child, so they
 * auto-join it (see requestContext.ts `sequelizeClsNamespace`).
 */
export async function runInSavepoint<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
  const ambient = getRequestTransaction();
  if (ambient) {
    return sequelize.transaction({ transaction: ambient }, fn);
  }
  return sequelize.transaction(fn);
}
