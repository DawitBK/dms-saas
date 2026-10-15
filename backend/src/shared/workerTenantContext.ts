import { randomUUID } from "node:crypto";
import { sequelize } from "../infrastructure/database/index.js";
import { logger } from "../core/logger.js";
import {
  requestContextStore,
  setRequestTenantId,
  setRequestTransaction,
} from "./requestContext.js";

/**
 * FIX: background workers never established any tenant context at all — no
 * AsyncLocalStorage store (so nothing they call auto-joins a transaction),
 * and no `SET LOCAL app.current_tenant` (so RLS-protected tables would be
 * invisible/unwritable to them the day the app's DB role is switched away
 * from superuser). `tenantContext` in shared/middleware.ts does both of
 * these for HTTP requests; this is the worker-side equivalent for any
 * worker step that operates on a SPECIFIC tenant's rows (the common case —
 * a retention/workflow/SLA sweep processing one row at a time, each row
 * belonging to a known tenant).
 *
 * Note this does not by itself fix the broader "worker does one big
 * cross-tenant SELECT with no tenant GUC" pattern some sweeps still use —
 * under real RLS enforcement (non-superuser DB role) that initial SELECT
 * would still need either a per-tenant loop or an explicit worker-bypass RLS
 * policy on the tables it scans. This closes the write-side half of the gap:
 * once a worker has a specific row and its tenantId in hand, every mutation
 * it makes for that row now runs inside a properly tenant-scoped
 * transaction, the same way a request handler's would.
 */
export async function withWorkerTenantContext<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStore.run(
    { correlationId: randomUUID() },
    async () => {
      setRequestTenantId(tenantId);
      const transaction = await sequelize.transaction();
      setRequestTransaction(transaction);
      try {
        await sequelize.query(`SET LOCAL app.current_tenant = :tenantId`, {
          transaction,
          replacements: { tenantId },
        });
        const result = await fn();
        await transaction.commit();
        return result;
      } catch (error) {
        await transaction.rollback().catch(() => {});
        logger.error({ error, tenantId }, "withWorkerTenantContext: operation failed, rolled back");
        throw error;
      } finally {
        setRequestTransaction(undefined);
      }
    },
  );
}
