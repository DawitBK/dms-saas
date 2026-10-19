/**
 * Seat limit (contract sections 1.3 and 6): CREATING or ACTIVATING an account beyond `maxUsers` is refused with
 * 403 LICENSE_SEAT_LIMIT. Existing users are never deactivated or blocked by it, and platform administrators
 * are outside both the count and the refusal.
 *
 * Call sites (every way an account becomes active), all through `withSeatGuard`: users.service createUser,
 * activateUser and updateUser with isActive:true, and the OIDC just-in-time provisioning in auth/ssoIdentity.ts.
 * DMS has no bulk-import endpoint; scripts that seed accounts are operator tools, not the request path.
 */
import type { Transaction } from "sequelize";
import { AppError } from "../../core/AppError.js";
import { logger } from "../../core/logger.js";
import { sequelize } from "../../infrastructure/database/sequelize.js";
import { getPlatformAdminUserIds } from "../../shared/platformAdmin.js";
import { runInTransaction } from "../../shared/transaction.js";
import { LICENSE_ERROR, LICENSE_SEAT_LOCK_KEY, SEAT_LIMIT_MESSAGE } from "./license.constants.js";
import { countSeatsUsed, getLicenseSnapshot, invalidateSeatCache } from "./license.service.js";

interface SeatLimit {
  maxUsers: number;
  mode: "enforce" | "warn";
}

/** The limit that applies, or null when nothing is to be enforced (off, unconfigured, unknown, no `maxUsers`, platform admin). */
async function seatLimitInForce(opts: { userId?: string }): Promise<SeatLimit | null> {
  const snapshot = getLicenseSnapshot();
  if (snapshot.mode === "off" || snapshot.state === "unconfigured" || snapshot.state === "unknown") return null;
  const maxUsers = snapshot.claims?.maxUsers ?? null;
  if (maxUsers === null) return null;
  if (opts.userId && (await getPlatformAdminUserIds()).includes(opts.userId)) return null;
  return { maxUsers, mode: snapshot.mode === "warn" ? "warn" : "enforce" };
}

/** The count and the refusal (in warn mode: only a log line). The caller has already established that a limit applies. */
async function checkSeats(limit: SeatLimit, via: string): Promise<void> {
  const used = await countSeatsUsed();
  if (used < limit.maxUsers) return;
  if (limit.mode === "warn") {
    logger.warn({ used, maxUsers: limit.maxUsers, via }, "licence (warn mode): seat limit reached; the account was still allowed");
    return;
  }
  logger.warn({ used, maxUsers: limit.maxUsers, via }, "licence: seat limit reached; account creation/activation refused");
  throw new AppError(403, LICENSE_ERROR.SEAT_LIMIT, SEAT_LIMIT_MESSAGE, { maxUsers: limit.maxUsers, seatsUsed: used });
}

/**
 * Throws 403 LICENSE_SEAT_LIMIT when one more active account would exceed the limit.
 * No-op when: enforcement is off, nothing is enforced (`unconfigured`/`unknown`), `maxUsers` is null, or the
 * account in question is a platform administrator. In `warn` mode it logs and lets the action through.
 *
 * This bare check is NOT atomic with the insert that follows it. Every path that adds an active account uses
 * `withSeatGuard` instead; this is for callers that only want the verdict.
 *
 * @param opts.userId  the account being activated (omit for a brand-new account)
 */
export async function assertSeatAvailable(opts: { userId?: string; via: string }): Promise<void> {
  const limit = await seatLimitInForce(opts);
  if (limit) await checkSeats(limit, opts.via);
}

/**
 * Check-and-write, atomically. Runs `fn` in a transaction (the request's own when one is open, see
 * shared/transaction.ts). When a seat limit is actually being ENFORCED it first takes a transaction-scoped
 * advisory lock (`pg_advisory_xact_lock`, one fixed key), then counts, then refuses or goes on. The lock is
 * held until that transaction commits, i.e. until the new or activated account is visible to the next
 * waiter's count, so two simultaneous creations at limit-1 cannot both pass. The count runs on its own
 * connection (installation-wide, never narrowed by a tenant's RLS), which is exactly why it has to wait for
 * the previous holder's commit.
 *
 * Nothing extra happens when no limit is in force (unconfigured, unknown, no `maxUsers`, off, platform
 * admin): no lock, no count. In `warn` mode the count is taken and logged but nothing is locked or refused.
 * `fn` gets the transaction; the inserts that take the seat must run in it (explicitly, or by the CLS join).
 */
export async function withSeatGuard<T>(
  opts: { userId?: string; via: string },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const limit = await seatLimitInForce(opts);
  if (!limit) return runInTransaction(fn);
  if (limit.mode === "warn") {
    await checkSeats(limit, opts.via);
    return runInTransaction(fn);
  }
  return runInTransaction(async (tx) => {
    await sequelize.query("SELECT pg_advisory_xact_lock(:key)", {
      replacements: { key: LICENSE_SEAT_LOCK_KEY },
      transaction: tx,
    });
    await checkSeats(limit, opts.via);
    return fn(tx);
  });
}

/** After an account was created or activated, so the status endpoint's cached count is not stale. */
export function noteSeatsChanged(): void {
  invalidateSeatCache();
}
