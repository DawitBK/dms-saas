import { Router } from "express";
import rateLimit from "express-rate-limit";
import { AppError } from "../../core/AppError.js";
import { createRedisRateLimitStore } from "../../infrastructure/cache/rateLimitStore.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { LICENSE_INSTALL_MAX_TOKEN_LENGTH } from "./license.constants.js";
import { buildLicenseStatus, installLicense } from "./license.service.js";

export const licenseRoutes = Router();

/**
 * GET /license/status — any authenticated user (the frontend banner and menu read it). Contract section 5.
 * Mounted behind `authenticate` only (not tenantContext): the answer is installation-wide, and not holding a
 * pooled connection for the whole request keeps a polled endpoint cheap.
 */
licenseRoutes.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await buildLicenseStatus());
  }),
);

/**
 * Public half of the licence API, mounted BEFORE `authenticate` (api/v1/index.ts). Only POST /license/install lives
 * here: an operator may have no login yet because the system is not licensed, so the token's signature is the
 * authority, not a session (contract section 9).
 */
export const licensePublicRoutes = Router();

// Unauthenticated, so IP-limited: a signature check is cheap but not free, and nobody installs a licence ten times a minute.
const installRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  store: createRedisRateLimitStore("license-install"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "ERR-RATE-LIMIT", message: "Too many licence install attempts, please slow down" } },
});

/**
 * POST /license/install { token } — verified exactly like a token fetched from SSO (signature against the trusted
 * keys, typ, aud === license:dms, sys === dms), never lowers the stored `ver`, persisted so it survives a restart.
 * Answers 200 with the new status when the token is held (or was already held / is older than the held one, said in
 * `outcome`), 400 when it does not verify, 503 when verification needed SSO's JWKS and SSO would not answer.
 */
licensePublicRoutes.post(
  "/license/install",
  installRateLimiter,
  asyncHandler(async (req, res) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length === 0 || token.length > LICENSE_INSTALL_MAX_TOKEN_LENGTH) {
      throw new AppError(400, "ERR-LICENSE-INVALID", "A licence token (a compact JWS string) is required in the 'token' field");
    }
    const { outcome } = await installLicense(token.trim());
    if (outcome === "rejected") {
      throw new AppError(400, "ERR-LICENSE-INVALID", "The licence token was not accepted: it is not signed by a trusted licence key, or it is not a licence for DMS");
    }
    if (outcome === "unavailable") {
      throw new AppError(503, "ERR-LICENSE-UNVERIFIABLE", "The licence token could not be verified right now. Try again shortly");
    }
    res.set("Cache-Control", "no-store");
    res.json({ outcome, installed: outcome === "updated" || outcome === "unchanged", status: await buildLicenseStatus() });
  }),
);
