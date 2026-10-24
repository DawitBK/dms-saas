/**
 * Platform licensing, DMS side. The binding contract is docs/operations/PLATFORM-LICENSING.md at the repo
 * root; every value here that the contract defines is quoted from it, and tests/license.catalog.test.ts
 * pins the module list to its section 7.
 */

/** This system's key in the `licenses` table, the token's `sys` claim and its `aud` suffix. */
export const LICENSE_SYSTEM = "dms" as const;

/** JWS header `typ` SSO stamps on every licence token (contract section 4). */
export const LICENSE_TOKEN_TYP = "kcms-license+jwt";

/** The expected `aud` claim. */
export const LICENSE_TOKEN_AUDIENCE = `license:${LICENSE_SYSTEM}`;

/**
 * The ONE place the SSO route is written down: `GET {LICENSE_SSO_URL}<this>`. SSO's backend serves its API
 * under `/api/v1` on its own port (SSO's `main.ts` mounts apiV1Router there); the licence routes are
 * `GET /licenses/public/:system` (unauthenticated) under it (contract section 5). Change it here only.
 */
export const LICENSE_SSO_PUBLIC_PATH = `/api/v1/licenses/public/${LICENSE_SYSTEM}`;

/** SSO's "SSO ends on this date" note (licenseCeiling.ts, contract section 10): DMS ends no later than SSO does. `GET {LICENSE_SSO_URL}<this>`. */
export const LICENSE_SSO_CEILING_PATH = "/api/v1/licenses/public/sso-expiry";

/** Timeout for a fetch from SSO (contract section 6). */
export const LICENSE_FETCH_TIMEOUT_MS = 5_000;

/** How long the SSO JWKS is reused before it is fetched again (an unknown `kid` forces an immediate refresh). */
export const LICENSE_JWKS_TTL_MS = 3_600_000;

/** HTTP error codes, verbatim from the contract (the other two systems and the frontends match on them). */
export const LICENSE_ERROR = {
  EXPIRED: "LICENSE_EXPIRED",
  MODULE_DISABLED: "LICENSE_MODULE_DISABLED",
  SEAT_LIMIT: "LICENSE_SEAT_LIMIT",
  /** Contract section 9: LICENSE_REQUIRED is on and no (entitling) licence is held. */
  REQUIRED: "LICENSE_REQUIRED",
} as const;

export const LICENSE_REQUIRED_MESSAGE = "This system is not licensed. Contact your administrator.";

/** Longest token POST /license/install accepts (a real one is about 1 KB; the body parser itself allows 50 MB). */
export const LICENSE_INSTALL_MAX_TOKEN_LENGTH = 16_384;

export const LICENSE_EXPIRED_MESSAGE =
  "The licence has expired; the system is read-only. Contact your administrator.";

/**
 * Gateable DMS modules (contract section 7). Core is never gateable: documents, folders, versions,
 * document-types, access-rules/acl, roles, users, org-units, departments, tenants, audit, auth, comments,
 * notifications, operations, feature-flags.
 */
export const DMS_LICENSE_MODULES = [
  "letters",
  "workflow",
  "esigning",
  "legal_hold",
  "retention",
  "ai",
  "ocr",
  "search",
  "archive",
  "reports",
  "bundles",
  "webhooks",
  "forms",
] as const;

export type LicenseModuleKey = (typeof DMS_LICENSE_MODULES)[number];

export const MODULE_DISABLED_MESSAGE = "This module is not included in your licence. Contact your administrator.";
/**
 * Fixed key of the transaction-scoped Postgres advisory lock that serialises "count the seats, then add an
 * active account" (licenseSeats.withSeatGuard). One key for the whole installation, as the count is.
 * Spells "DMSS" in ASCII; the audit chain's lock is hashtext-derived, so the two cannot realistically meet.
 */
export const LICENSE_SEAT_LOCK_KEY = 1145982803;

export const SEAT_LIMIT_MESSAGE =
  "The licence's user limit has been reached; no further accounts can be created or activated. Contact your administrator.";
