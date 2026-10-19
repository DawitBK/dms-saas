/**
 * The licence state function: PURE, no I/O, no clock of its own. The same function, with the same
 * boundaries, is implemented in SSO and GMS (contract section 3), so keep it free of anything DMS-specific.
 *
 *   unconfigured  no licence record (SSO answered "none")        -> nothing enforced
 *   unknown       this process has never obtained a verified token -> nothing enforced
 *   active        perpetual, or now <  expires - warnDays
 *   expiring      expires - warnDays <= now <  expires            -> banner only
 *   grace         expires            <= now <  expires + graceDays -> banner only, full function
 *   expired       now >= expires + graceDays                       -> READ-ONLY
 *
 * Kept in step with SSO's `SSO/backend/src/licenses/state.ts` (the contract's reference copy; GMS and DMS copy it). Every
 * boundary is inclusive on its lower edge: at the exact instant of `expires - warnDays` the state is
 * already `expiring`, at `expires` already `grace`, at `expires + graceDays` already `expired`.
 */

export type LicenseState = "unconfigured" | "unknown" | "active" | "expiring" | "grace" | "expired";

export interface LicenseTerms {
  /** null = perpetual. */
  expiresAt: Date | null;
  graceDays: number;
  warnDays: number;
}

export interface LicenseEvaluation {
  state: LicenseState;
  /**
   * Whole days from now to `expiresAt`, truncated toward zero (2.9 days left -> 2, 0.4 left -> 0, 0.4 past -> 0,
   * 2.9 past -> -2), the same rule as SSO's licenses/state.ts; never -0. null when perpetual or when there is no licence.
   */
  daysRemaining: number | null;
  /** expiresAt + graceDays; null when perpetual or when there is no licence. */
  graceEndsAt: Date | null;
}

export const DAY_MS = 86_400_000;

/**
 * @param terms        the held licence, or null when there is none
 * @param now          the instant to evaluate at (the server clock is the time source)
 * @param whenNoTerms  what "no terms" means: `unconfigured` when SSO said there is no record, `unknown` when
 *                     this process has simply never obtained a token. Neither enforces anything.
 */
export function computeLicenseState(
  terms: LicenseTerms | null,
  now: Date,
  whenNoTerms: "unconfigured" | "unknown" = "unconfigured",
): LicenseEvaluation {
  if (!terms) return { state: whenNoTerms, daysRemaining: null, graceEndsAt: null };
  if (terms.expiresAt === null) return { state: "active", daysRemaining: null, graceEndsAt: null };

  const expires = terms.expiresAt.getTime();
  const t = now.getTime();
  const graceEnds = expires + terms.graceDays * DAY_MS;
  const warnStarts = expires - terms.warnDays * DAY_MS;

  const remaining = Math.trunc((expires - t) / DAY_MS);

  let state: LicenseState;
  if (t >= graceEnds) state = "expired";
  else if (t >= expires) state = "grace";
  else if (t >= warnStarts) state = "expiring";
  else state = "active";

  return {
    state,
    daysRemaining: remaining === 0 ? 0 : remaining, // never -0
    graceEndsAt: new Date(graceEnds),
  };
}
