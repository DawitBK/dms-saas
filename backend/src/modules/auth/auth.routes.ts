/**
 * DMS Auth Routes
 *
 * Mock endpoints (gated on LOCAL_JWT_MOCK=true; NOT 404'd in production since
 * 2026-07-31 — explicit user decision to allow passwordless sign-in as the
 * seeded demo accounts on the production box, see config/env.ts's
 * assertProductionRuntimeRequirements and shared/auth.ts's getPublicKey):
 *   POST /auth/login      — passwordless email login; issues RS256 JWT
 *   POST /auth/dev/token  — explicit { userId, role, tenantId } token (tests only)
 *
 * Production endpoints:
 *   GET  /auth/me         — returns principal identity + resolved permissions
 *   POST /auth/verify     — health stub
 *
 * Controlled by env: LOCAL_JWT_MOCK, DEV_RSA_PRIVATE_KEY, DEV_RSA_PUBLIC_KEY,
 *                    DEV_JWT_ISSUER, DEV_JWT_AUDIENCE
 *
 * The permissions field in /auth/me and /auth/login responses is the authoritative
 * frontend source for all UI gating — role is informational only and must never be
 * string-matched in business logic or UI rendering decisions.
 *
 * This file is transport only — request parsing, response shaping, cookie
 * mechanics, and error-code mapping. Every business rule (token minting,
 * OIDC exchange, TOTP verification, revocation checks, DB reads/writes) lives
 * in `auth.service.ts` and is called from here with plain arguments.
 */
import { Router } from 'express';
import { authenticate } from '../../shared/auth.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../core/AppError.js';
import {
  loginMock,
  issueDevToken,
  selectTenant,
  switchTenant,
  selectRole,
  switchRole,
  refreshSession,
  recordLogout,
  setupTotp,
  confirmTotp,
  validateTotp,
  disableTotp,
  beginOidcAuthorize,
  consumeOidcState,
  completeOidcCallback,
  refreshOidcJwks,
  handleBackchannelLogout,
  refreshCookieOptions,
  OIDC_BIND_COOKIE,
  type AuthResult,
} from './auth.service.js';

export const authRoutes = Router();

// Used to 404 this route in production unconditionally. Relaxed 2026-07-31 by
// explicit user decision alongside the LOCAL_JWT_MOCK boot guard (config/env.ts)
// so the passwordless mock login can be used on the production box; the
// LOCAL_JWT_MOCK check right below in the handler is the real gate now — with
// it left false (the default), this route still 403s in any environment.
const devOnly = (_req: any, _res: any, next: any) => {
  next();
};

/** Every route that may issue a fresh refresh token shares this: set the
 *  cookie when one comes back, then respond with the service's JSON body. */
function respondWithAuthResult(res: any, result: AuthResult): void {
  if (result.refreshToken) {
    res.cookie('refreshToken', result.refreshToken, refreshCookieOptions());
  }
  res.json(result.responseBody);
}

/**
 * POST /auth/login  (dev-only)
 * Accepts { email } — password-less for local development. See auth.service's
 * loginMock for the full mock-login/tenant-selection/MFA-pending logic.
 */
authRoutes.post(
  '/login',
  devOnly,
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email?: string };
    if (!email) throw new AppError(400, 'ERR-INVALID-INPUT', 'email is required');
    const result = await loginMock(email);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/dev/token  (dev-only, legacy)
 * Issues a token given explicit { userId, role, tenantId } — useful for tests.
 */
authRoutes.post(
  '/dev/token',
  devOnly,
  asyncHandler(async (req, res) => {
    const { userId, role, tenantId } = req.body;
    if (!userId || !role || !tenantId) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'userId, role, and tenantId are required');
    }
    const result = await issueDevToken(userId, role, tenantId);
    res.json(result);
  }),
);

/** GET /auth/me — returns the current token's identity + resolved permissions */
authRoutes.get('/me', authenticate, (req, res) => {
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ user: req.user });
});

/** POST /auth/verify — health stub */
authRoutes.post('/verify', (_req, res) => res.status(204).send());

/**
 * POST /auth/select-tenant
 * Called when user has multiple tenants - verifies membership and issues full JWT
 */
authRoutes.post(
  '/select-tenant',
  asyncHandler(async (req, res) => {
    const { tenantId } = req.body as { tenantId?: string };
    if (!tenantId) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'tenantId is required');
    }

    // Extract user ID from pre-tenant token
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Pre-tenant token required');
    }

    const result = await selectTenant(token, tenantId);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/switch-tenant
 * Called by authenticated user to switch to a different tenant they have access to
 */
authRoutes.post(
  '/switch-tenant',
  authenticate,
  asyncHandler(async (req, res) => {
    const { tenantId } = req.body as { tenantId?: string };
    if (!tenantId) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'tenantId is required');
    }
    const result = await switchTenant(req.user!, tenantId);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/select-role
 * Called when login/select-tenant deferred which role to sign in as (the
 * user holds more than one) — verifies the pre-role token and issues the
 * full JWT scoped to just the chosen role.
 */
authRoutes.post(
  '/select-role',
  asyncHandler(async (req, res) => {
    const { roleName } = req.body as { roleName?: string };
    if (!roleName) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'roleName is required');
    }

    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new AppError(401, 'ERR-AUTH-REQUIRED', 'Pre-role token required');
    }

    const result = await selectRole(token, roleName);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/switch-role
 * Called by an authenticated user who holds more than one role to change
 * which one they're currently acting as, without a full re-login.
 */
authRoutes.post(
  '/switch-role',
  authenticate,
  asyncHandler(async (req, res) => {
    const { roleName } = req.body as { roleName?: string };
    if (!roleName) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'roleName is required');
    }
    const result = await switchRole(req.user!, roleName);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/refresh
 * Reads the HttpOnly `refreshToken` cookie and issues a new RS256 access
 * token + rotated refresh cookie. See auth.service's refreshSession for the
 * revocation/reuse-detection logic.
 */
authRoutes.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const rawRefreshToken = (req as any).cookies?.refreshToken as string | undefined;
    const result = await refreshSession(rawRefreshToken);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/logout
 * Revokes the current access + refresh token (see auth.service's recordLogout)
 * and clears the refresh cookie.
 */
authRoutes.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const rawRefreshToken = (req as any).cookies?.refreshToken as string | undefined;
    await recordLogout(token, rawRefreshToken, req.user);

    // Path MUST match every res.cookie('refreshToken', ...) call, or the
    // browser keeps the cookie and logout does not actually clear it (P1-11).
    res.clearCookie('refreshToken', refreshCookieOptions());
    res.status(204).send();
  }),
);

// ─── TOTP / 2FA Endpoints ────────────────────────────────────────────────────

/**
 * POST /auth/totp/setup  (authenticated)
 * Generates a new TOTP secret + otpauth URI for the authenticator app.
 */
authRoutes.post(
  '/totp/setup',
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body as { code?: string };
    const result = await setupTotp(req.user!.userId, code);
    res.json(result);
  }),
);

/**
 * POST /auth/totp/confirm  (authenticated)
 * Verifies the TOTP code against mfaTempSecret and permanently enables MFA.
 */
authRoutes.post(
  '/totp/confirm',
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body as { code?: string };
    if (!code) throw new AppError(400, 'ERR-INVALID-INPUT', 'code is required');
    await confirmTotp(req.user!.userId, code);
    res.json({ mfaEnabled: true });
  }),
);

/**
 * POST /auth/totp/validate
 * Exchanges an MFA-pending token + TOTP code for a full access token.
 */
authRoutes.post(
  '/totp/validate',
  asyncHandler(async (req, res) => {
    const { mfaPendingToken, code } = req.body as { mfaPendingToken?: string; code?: string };
    if (!mfaPendingToken || !code) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'mfaPendingToken and code are required');
    }
    const result = await validateTotp(mfaPendingToken, code);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/totp/disable  (authenticated)
 * Disables MFA for the authenticated user. Requires a valid TOTP code.
 */
authRoutes.post(
  '/totp/disable',
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body as { code?: string };
    if (!code) throw new AppError(400, 'ERR-INVALID-INPUT', 'code is required');
    await disableTotp(req.user!.userId, code);
    res.json({ mfaEnabled: false });
  }),
);

// (The former /auth/.well-known/jwks dev stub — kid 'dev-key', placeholder
// modulus — was removed: the real JWKS with the actual RSA modulus is served
// app-wide at /.well-known/jwks.json in app.ts, and nothing referenced this one.)

// ─── SSO / OIDC ──────────────────────────────────────────────────────────────
//
// To enable: set AUTH_ISSUER, AUTH_JWKS_URI, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
// OIDC_REDIRECT_URI in backend/.env.
// The OIDC flow: GET /auth/oidc/authorize → IdP → GET OIDC_REDIRECT_URI?code=&state=
// → frontend posts code+state to POST /auth/callback → backend exchanges code for
// tokens, verifies ID token, and issues an DMS access JWT.

/**
 * GET /auth/oidc/authorize
 * Builds and redirects to the IdP authorization URL, setting the
 * browser-binding cookie the callback checks against.
 */
authRoutes.get(
  '/oidc/authorize',
  asyncHandler(async (_req, res) => {
    const { redirectUrl, bindingToken, bindCookieMaxAgeMs } = await beginOidcAuthorize();

    res.cookie(OIDC_BIND_COOKIE, bindingToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // 'lax', not 'strict': the browser returns from the IdP by a top-level
      // cross-site redirect and 'strict' would withhold the cookie on exactly
      // that navigation, breaking every SSO login.
      sameSite: 'lax',
      path: '/',
      maxAge: bindCookieMaxAgeMs,
    });

    res.redirect(redirectUrl);
  }),
);

/**
 * POST /auth/callback
 * Receives the authorization code + state from the frontend after the IdP
 * redirect, exchanges for tokens, verifies the ID token against JWKS, finds or
 * creates the local user, and issues an DMS RS256 access token + refresh cookie.
 *
 * Body: { code: string, state: string }
 */
authRoutes.post(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.body as { code?: string; state?: string };
    if (!code || !state) {
      throw new AppError(400, 'ERR-INVALID-INPUT', 'code and state are required');
    }

    // Verify state is a known, unexpired nonce (CSRF guard).
    const pendingState = await consumeOidcState(state);
    res.clearCookie(OIDC_BIND_COOKIE, { path: '/' });
    if (!pendingState) {
      throw new AppError(400, 'ERR-OIDC-STATE-INVALID', 'Unknown or expired state parameter');
    }

    const presentedBinding = (req as any).cookies?.[OIDC_BIND_COOKIE] as string | undefined;
    const result = await completeOidcCallback(code, pendingState, presentedBinding);
    respondWithAuthResult(res, result);
  }),
);

/**
 * POST /auth/oidc/jwks/refresh
 * Force-refreshes the cached JWKS from AUTH_JWKS_URI.
 * Protected — only SYSTEM_ADMIN can trigger this; useful after a key rotation event.
 */
authRoutes.post(
  '/oidc/jwks/refresh',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'SYSTEM_ADMIN') {
      throw new AppError(403, 'ERR-FORBIDDEN', 'Only SYSTEM_ADMIN can refresh JWKS');
    }
    const result = await refreshOidcJwks();
    res.json(result);
  }),
);

/**
 * POST /auth/backchannel-logout
 * OIDC backchannel logout receiver. The IdP POSTs a signed logout token when
 * a user signs out at the SSO portal or is disabled.
 */
authRoutes.post(
  '/backchannel-logout',
  // No inline body-parser needed — express.urlencoded() is already applied
  // globally in app.ts, ahead of every route.
  asyncHandler(async (req, res) => {
    const logoutToken = String((req.body as Record<string, unknown>)?.logout_token ?? '');
    await handleBackchannelLogout(logoutToken);
    // Always 200 for unknown users — do not leak which subjects exist here.
    res.json({ ok: true });
  }),
);
