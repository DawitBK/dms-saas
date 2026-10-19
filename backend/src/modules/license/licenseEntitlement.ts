/**
 * Per-application ENTITLEMENT (docs/operations/PLATFORM-LICENSING.md section 9): may this system be used at all?
 *
 * Pure, no I/O, no clock. It is a layer on top of the state function (licenseState.ts, which stays untouched):
 * expiry is still `expired` = read-only; this only decides "licensed or not" for a deployment. GMS, DMS and SSO
 * each carry one of these and the rules are the contract's, verbatim:
 *
 *   - LICENSE_REQUIRED false                               -> licensed (today's behaviour)
 *   - required, no verified token (unconfigured / unknown) -> NOT licensed, reason NO_LICENSE
 *   - required, token verified, `modes` lacks the deployment's mode -> NOT licensed, reason MODE_NOT_LICENSED
 *   - otherwise                                            -> licensed
 */
import type { LicenseState } from "./licenseState.js";

export type DeploymentMode = "sso" | "standalone";
export type EntitlementReason = "NO_LICENSE" | "MODE_NOT_LICENSED";

export interface EntitlementInput {
  /** config.LICENSE_REQUIRED */
  required: boolean;
  /** The state function's verdict for the held token (`unconfigured` / `unknown` = no verified token). */
  state: LicenseState;
  /** The held token's `modes` claim; null, undefined or empty means ["sso"]. */
  modes: readonly string[] | null | undefined;
  /** Computed by this process from its own SSO configuration, never taken from a client. */
  deployment: DeploymentMode;
}

export interface Entitlement {
  licensed: boolean;
  reason: EntitlementReason | null;
}

export function computeEntitlement(input: EntitlementInput): Entitlement {
  if (!input.required) return { licensed: true, reason: null };
  if (input.state === "unconfigured" || input.state === "unknown") return { licensed: false, reason: "NO_LICENSE" };
  const modes = input.modes && input.modes.length > 0 ? input.modes : ["sso"];
  if (!modes.includes(input.deployment)) return { licensed: false, reason: "MODE_NOT_LICENSED" };
  return { licensed: true, reason: null };
}
