import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { QueryTypes } from "sequelize";
import { config } from "../config/env.js";
import { PERMISSIONS } from "../config/permissions.js";
import { AppError } from "../core/AppError.js";
import { logger } from "../core/logger.js";
import { sequelize } from "../infrastructure/database/index.js";

/**
 * Gate for the small internal admin API the IdP's admin console calls to
 * manage DMS role permissions and per-user permission overrides on an
 * admin's behalf (SSO/backend/src/admin/dms-internal-client.ts). The IdP has no DMS user
 * session to act under, so it authenticates with a shared secret instead of a
 * JWT, and this middleware synthesizes a `req.user` holding every permission
 * — the IdP admin console is itself gated behind its own admin-group check,
 * so by the time a request reaches here it has already been authorized by
 * the IdP; this is trust-the-caller, not a second authorization layer.
 * `x-internal-actor` (the IdP admin's email) is threaded through purely for
 * audit-log attribution.
 */
/**
 * Constant-time comparison of the presented internal API key.
 *
 * This was a plain `provided !== config.DMS_INTERNAL_API_KEY`, which returns as
 * soon as it finds a differing byte -- a timing oracle on a static shared
 * secret that, on success, grants EVERY permission on whatever tenant the
 * caller names (see the req.user synthesis below). GMS's equivalent gate
 * (modules/auth/internal-sso.routes.ts) already compares in constant time;
 * this side did not.
 *
 * Hashing both operands first sidesteps timingSafeEqual's equal-length
 * requirement, so the key's length does not leak either.
 */
function internalKeyMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * P1-10: network allowlist, evaluated BEFORE the key is compared.
 *
 * Two things this buys that the key alone does not: a remote attacker cannot
 * brute-force the static secret at network speed, and a timing measurement of the
 * comparison is unreachable from off-box. Every real caller is the SSO backend on
 * loopback, so the allowlist is not a compromise — it is the actual topology.
 */
const ALLOWED_INTERNAL_IPS = new Set(
  config.INTERNAL_API_ALLOWED_IPS.split(",").map((v) => v.trim()).filter(Boolean),
);
const INTERNAL_ALLOWLIST_DISABLED = ALLOWED_INTERNAL_IPS.has("*");

function normalizeIp(ip: string): string {
  // Express reports IPv4-mapped IPv6 for loopback on dual-stack listeners.
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Rate limit for the internal mount. Raised 60 -> 600/min (2026-09-23): this
 * mount is also on SSO's own login critical path (client-role-claims.ts's
 * resolveEdamsRolesFromGroups calls the /role-mappings/resolve route here on
 * every OIDC login, not just IdP admin-console page views), so at real
 * company-wide login volume the old 60/min risked 429ing logins platform-wide
 * rather than just throttling the admin console. Still far below what a
 * key-guessing loop needs, and this mount is shared-secret authenticated and
 * not internet-exposed to begin with. Logged rejections carry only the first
 * 6 characters of the presented key — enough to correlate a misconfigured
 * caller, useless to an attacker reading logs.
 */
export const internalApiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(
      { ip: req.ip, keyPrefix: (req.header("x-internal-api-key") ?? "").slice(0, 6) },
      "internal API rate limit exceeded",
    );
    res.status(429).json({
      error: { code: "ERR-RATE-LIMITED", message: "Too many internal API requests" },
    });
  },
});

/**
 * `x-internal-actor` is the IdP admin's email, threaded through for audit
 * attribution. It is ASSERTED BY THE CALLER and verified by nothing — whoever
 * holds the shared key can put any string in it. Validating the shape at least
 * stops arbitrary content reaching audit rows and log lines; see internalActor()
 * below for how it is labelled.
 */
const ACTOR_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function requireInternalApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!config.DMS_INTERNAL_API_KEY) {
    throw new AppError(503, "ERR-INTERNAL-API-DISABLED", "DMS_INTERNAL_API_KEY is not configured — internal admin API is disabled");
  }

  // Before the key comparison, deliberately.
  if (!INTERNAL_ALLOWLIST_DISABLED) {
    // The SOCKET PEER, deliberately, not `req.ip`. Now that app.ts honours
    // TRUST_PROXY (default `loopback`), `req.ip` on a loopback request is
    // whatever that request put in `X-Forwarded-For` — which is exactly the
    // value this allowlist is supposed to be proving. Reading the raw peer
    // address keeps the check on the one thing a caller cannot assert about
    // itself, so the network boundary this gate documents ("every real caller
    // is the SSO backend on loopback") holds regardless of how TRUST_PROXY is
    // configured, and stays correct if it is ever widened.
    const sourceIp = normalizeIp(req.socket?.remoteAddress ?? "");
    if (!sourceIp || !ALLOWED_INTERNAL_IPS.has(sourceIp)) {
      logger.warn(
        { ip: req.ip, path: req.originalUrl, keyPrefix: (req.header("x-internal-api-key") ?? "").slice(0, 6) },
        "internal API request from a non-allowlisted address — rejected before key comparison",
      );
      throw new AppError(403, "ERR-INTERNAL-API-FORBIDDEN", "Internal API is not reachable from this address");
    }
  }

  const provided = req.header("x-internal-api-key");
  if (!provided || !internalKeyMatches(provided, config.DMS_INTERNAL_API_KEY)) {
    logger.warn(
      { ip: req.ip, keyPrefix: (provided ?? "").slice(0, 6) },
      "internal API request with a missing or invalid key",
    );
    throw new AppError(401, "ERR-INTERNAL-API-UNAUTHORIZED", "Invalid or missing internal API key");
  }

  const rawActor = req.header("x-internal-actor");
  if (rawActor !== undefined && !ACTOR_PATTERN.test(rawActor.trim())) {
    throw new AppError(400, "ERR-INVALID-INPUT", "x-internal-actor must be an email address");
  }

  const tenantId = String(req.params.tenantId ?? "");
  if (!tenantId) {
    throw new AppError(400, "ERR-INVALID-INPUT", "tenantId is required");
  }

  /**
   * The tenant id is caller-supplied and was previously written straight into the
   * synthesized principal (and from there into `SET LOCAL app.current_tenant` via
   * tenantContext) with no check that it names a real tenant. Confirm it exists
   * before granting anything on it — an unknown tenant is a 400, not a silently
   * empty RLS scope that looks like "no data" to the caller.
   */
  const tenantRows = await sequelize.query<{ id: string }>(
    "SELECT id FROM tenants WHERE id = :tenantId LIMIT 1",
    { replacements: { tenantId }, type: QueryTypes.SELECT },
  );
  if (tenantRows.length === 0) {
    throw new AppError(400, "ERR-TENANT-NOT-FOUND", "Unknown tenantId");
  }

  req.user = {
    // Nil UUID sentinel — audit_logs.user_id is a UUID column, so this must be
    // a syntactically valid UUID, not a label. The real actor (the IdP admin's
    // email) travels in x-internal-actor and is recorded by the route handler.
    userId: "00000000-0000-0000-0000-000000000000",
    role: "SYSTEM_ADMIN",
    roles: ["SYSTEM_ADMIN"],
    tenantId,
    /**
     * Still the full permission set, deliberately — and this is NOT the same as
     * "nobody narrowed it".
     *
     * The routes behind this gate do not call requirePermission; they pass
     * `req.user.permissions` into replaceRolePermissions /
     * replaceUserPermissionOverrides as the PRIVILEGE-ESCALATION CEILING ("a role
     * editor may only grant permissions they themselves hold",
     * roles.service.ts:277). Narrowing this set would therefore not reduce what
     * this endpoint can reach — it would silently stop the IdP admin console from
     * granting the permissions it is designed to grant, and the failure would look
     * like a mysterious ERR-PERMISSION-ESCALATION on a legitimate admin action.
     *
     * The IdP admin console is, by design, a DMS super-admin acting on an admin's
     * behalf. That is why the controls that matter for this endpoint are the
     * network allowlist and the rate limit above, not a narrower permission list.
     */
    permissions: Object.values(PERMISSIONS),
  };
  next();
}

/**
 * The acting admin's email as ASSERTED by the internal caller.
 *
 * Shape-validated in requireInternalApiKey, but not verified against anything —
 * the key holder chooses it freely. Audit rows written from it must say so; see
 * the `actorAssertedByInternalCaller` flag the route handlers record alongside it.
 */
export function internalActor(req: Request): string | null {
  const actor = req.header("x-internal-actor");
  return actor && actor.trim() ? actor.trim() : null;
}

/** Marker for audit payloads: this actor was asserted, not authenticated. */
export const INTERNAL_ACTOR_IS_ASSERTED = true;
